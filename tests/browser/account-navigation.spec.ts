import {test, expect} from '@playwright/test';
import sharp from 'sharp';
import {createHmac,randomBytes} from 'node:crypto';
import {openLocalKeyBridge} from '../../services/runner/local-key-bridge.ts';

const readOnlyMessaging={canSend:false,reason:'unsupported',messages:[]};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test.beforeEach(async ({request}) => {await request.post('/__fixture/reset', {data: {mode: 'multiple'}});});

test('task conversation shows live replies and authoritative execution status without messaging support',async({page,request})=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111';
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'支持任务执行过程查看'}})).json();
  let finished=false,reads=0,messageCount=0;
  const methods:string[]=[];
  await page.route(`**/tasks/${taskId}/conversation/messages`,route=>{
    reads++;methods.push(route.request().method());
    return route.fulfill({json:{identityId,projectId,taskId,messaging:readOnlyMessaging,taskStatus:finished?'review':'running',attempt:{id:id(92),state:finished?'finished':'running',agentName:'代码助手',live:!finished,updatedAt:'2026-10-24T08:00:00.000Z',snapshot:{revision:finished?40:messageCount+1,truncated:false,entries:[
      {id:'reply',kind:'message',text:finished?'修改已提交，请核对验收标准。':'已找到任务入口，正在检查调用关系。',state:'completed',at:1},
      {id:'tool',kind:'tool',text:'运行回归检查',state:finished?'completed':'running',at:2},
      ...Array.from({length:messageCount},(_,index)=>({id:'reply-'+index,kind:'message',text:'检查进度 '+(index+1)+'：已确认当前步骤。',state:'completed',at:index+3})),
    ]}}}});
  });
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  const entry=page.getByRole('button',{name:'实时对话',exact:true});
  await entry.click();
  const dialog=page.getByRole('dialog',{name:'实时对话'}),stream=dialog.getByRole('log');
  await expect(stream).toContainText('已找到任务入口');
  await expect(dialog.getByText('执行中',{exact:true})).toBeVisible();
  await expect(stream).toContainText('运行回归检查');
  await expect(stream).toContainText('进行中');
  await expect(dialog.getByRole('textbox',{name:'给 Agent 发消息'})).toBeDisabled();
  await expect(dialog.getByRole('button',{name:/续接|停止/})).toHaveCount(0);
  await expect(dialog.getByText(/思考过程|原始日志/)).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  messageCount=20;
  await expect(stream).toContainText('检查进度 20');
  await expect.poll(()=>stream.evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight)).toBeLessThan(5);
  await stream.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll'));});
  messageCount=21;
  await expect(stream).toContainText('检查进度 21');
  expect(await stream.evaluate(node=>node.scrollTop)).toBe(0);
  finished=true;
  await expect(dialog.getByText('待验收',{exact:true})).toBeVisible();
  await expect(stream).toContainText('修改已提交');
  await expect(stream).toContainText('已完成');
  await expect(stream).not.toContainText('已找到任务入口');
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  await expect(entry).toBeFocused();
  const closedReads=reads;await page.waitForTimeout(2300);expect(reads).toBe(closedReads);
  expect(methods.every(method=>method==='GET')).toBe(true);
});

test('task conversation preserves messages while disconnected and clears a replaced or forbidden attempt',async({page,request})=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111';
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'检查实时对话恢复'}})).json();
  let failed=false,forbidden=false,replaced=false,reads=0;
  await page.route(`**/tasks/${taskId}/conversation/messages`,route=>{
    reads++;
    if(failed||forbidden)return route.fulfill({status:forbidden?403:503,json:{error:'Unavailable'}});
    return route.fulfill({json:{identityId,projectId,taskId,messaging:readOnlyMessaging,taskStatus:'running',attempt:{id:id(replaced?93:92),state:'running',agentName:'代码助手',live:false,updatedAt:null,snapshot:replaced?null:{revision:1,truncated:true,entries:[{id:'reply',kind:'message',text:'已读取入口文件。',state:'completed',at:1}]}}}});
  });
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  await page.getByRole('button',{name:'实时对话',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'实时对话'}),stream=dialog.getByRole('log');
  await expect(stream).toContainText('已读取入口文件');
  await expect(dialog).toContainText('不代表执行已停止');
  await expect(dialog).toContainText('较早内容已截断');
  failed=true;
  await expect(dialog.getByRole('alert')).toContainText('暂时无法读取');
  await expect(stream).toContainText('已读取入口文件');
  failed=false;
  await dialog.getByRole('button',{name:'重试读取',exact:true}).click();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  replaced=true;
  await expect(stream).toContainText('此轮对话尚未同步');
  await expect(stream).not.toContainText('已读取入口文件');
  forbidden=true;
  await expect(dialog.getByRole('alert')).toContainText('无权读取');
  await expect(dialog.getByRole('log')).toHaveCount(0);
  const deniedReads=reads;await page.waitForTimeout(2300);expect(reads).toBe(deniedReads);
});

test('task conversation rejects mismatched scope and closing aborts an unfinished read',async({page,request})=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111';
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'确认对话访问边界'}})).json();
  let mismatch=true,reads=0;
  const releases:(()=>void)[]=[];
  await page.route(`**/tasks/${taskId}/conversation/messages`,async route=>{
    reads++;
    if(!mismatch)await new Promise<void>(resolve=>{releases.push(resolve);});
    return route.fulfill({json:{identityId,projectId:mismatch?id(12):projectId,taskId,messaging:readOnlyMessaging,taskStatus:'pending',attempt:null}}).catch(()=>{});
  });
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  const entry=page.getByRole('button',{name:'实时对话',exact:true});
  await entry.click();
  let dialog=page.getByRole('dialog',{name:'实时对话'});
  await expect(dialog.getByRole('alert')).toContainText('无权读取');
  await dialog.press('Escape');
  await expect(entry).toBeFocused();
  mismatch=false;await entry.click();
  dialog=page.getByRole('dialog',{name:'实时对话'});
  await expect(dialog).toContainText('正在读取对话');
  await expect.poll(()=>releases.length).toBeGreaterThan(0);
  // Development StrictMode cancels its initial mount; only recurring reads matter here.
  await page.waitForTimeout(2300);const pendingReads=reads;
  await page.waitForTimeout(2300);expect(reads).toBe(pendingReads);
  const aborted=page.waitForEvent('requestfailed',r=>r.url().endsWith(`/tasks/${taskId}/conversation/messages`));
  await dialog.press('Escape');await aborted;
  releases.forEach(release=>release());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(entry).toBeFocused();
});

test('task conversation retries a timed-out read without losing the last messages',async({page,request})=>{
  await page.clock.install({time:new Date('2026-10-24T08:00:00.000Z')});
  // The browser's native timeout clock is separate from Playwright's fake timers.
  await page.addInitScript(()=>{AbortSignal.timeout=milliseconds=>{const controller=new AbortController();window.setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),milliseconds);return controller.signal;};});
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111';
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'读取超时后继续同步'}})).json();
  let phase:'initial'|'stalled'|'recovered'='initial';
  const releases:(()=>void)[]=[];
  await page.route(`**/tasks/${taskId}/conversation/messages`,async route=>{
    if(phase==='stalled'){await new Promise<void>(resolve=>releases.push(resolve));return route.fulfill({status:503,json:{error:'Unavailable'}}).catch(()=>{});}
    return route.fulfill({json:{identityId,projectId,taskId,messaging:readOnlyMessaging,taskStatus:'running',attempt:{id:id(92),state:'running',agentName:'代码助手',live:true,updatedAt:null,snapshot:{revision:phase==='initial'?1:2,truncated:false,entries:[{id:'reply',kind:'message',text:phase==='initial'?'已读取的任务回复。':'连接恢复后的任务回复。',state:'completed',at:1}]}}}});
  });
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  await page.getByRole('button',{name:'实时对话',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'实时对话'}),stream=dialog.getByRole('log');
  await expect(stream).toContainText('已读取的任务回复');
  phase='stalled';await page.clock.fastForward(2000);
  await expect.poll(()=>releases.length).toBeGreaterThan(0);
  await page.clock.fastForward(10_000);
  await expect(dialog.getByRole('alert')).toContainText('暂时无法读取');
  await expect(stream).toContainText('已读取的任务回复');
  phase='recovered';await page.clock.fastForward(2000);
  await expect(stream).toContainText('连接恢复后的任务回复');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  releases.forEach(release=>release());
});

test('task conversation does not claim a tool is still running after its attempt ends',async({page,request})=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111';
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'核对工具结束状态'}})).json();
  let stopped=false;
  await page.route(`**/tasks/${taskId}/conversation/messages`,route=>route.fulfill({json:{identityId,projectId,taskId,messaging:readOnlyMessaging,taskStatus:stopped?'failed':'review',attempt:{id:id(92),state:stopped?'stopped':'finished',agentName:'代码助手',live:false,updatedAt:null,snapshot:{revision:1,truncated:false,entries:[{id:'tool',kind:'tool',text:'运行回归检查',state:'running',at:1}]}}}}));
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  await page.getByRole('button',{name:'实时对话',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'实时对话'}),stream=dialog.getByRole('log');
  await expect(dialog).toContainText('本轮已结束');
  await expect(stream).toContainText('未收到结束状态');
  await expect(stream).not.toContainText('进行中');
  stopped=true;
  await expect(dialog).toContainText('本轮已停止');
  await expect(stream).toContainText('未收到结束状态');
  await expect(stream).not.toContainText('进行中');
});

test('task conversation sends with explicit keyboard shortcuts and displays delivery status',async({page,request},testInfo)=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111',attemptId=id(92);
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'发送执行补充信息'}})).json();
  const posts:any[]=[],messages:any[]=[];
  await page.route(`**/tasks/${taskId}/conversation/messages`,route=>{
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();posts.push(body);
      const message={id:id(100+posts.length),authorName:'测试成员',body:body.body,state:'queued',createdAt:'2026-10-24T08:00:01.000Z',error:null};messages.push(message);
      return route.fulfill({json:{identityId,projectId,taskId,attemptId,message}});
    }
    return route.fulfill({json:{identityId,projectId,taskId,taskStatus:'running',attempt:{id:attemptId,state:'running',agentName:'代码助手',live:true,updatedAt:null,snapshot:{revision:1,truncated:false,entries:[{id:'reply',kind:'message',text:'正在检查任务入口。',state:'completed',at:1792828800000}]}},messaging:{canSend:true,reason:null,messages}}});
  });
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  await page.getByRole('button',{name:'实时对话',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'实时对话'}),input=dialog.getByRole('textbox',{name:'给 Agent 发消息'}),stream=dialog.getByRole('log');
  await expect(input).toBeEnabled();
  await input.fill('请保留现有接口');await input.press('Enter');await input.press('End');await input.type('并补充回归检查');
  expect(posts).toHaveLength(0);
  await input.dispatchEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true});expect(posts).toHaveLength(0);
  await input.press('Control+Enter');
  await expect.poll(()=>posts.length).toBe(1);
  expect(posts[0]).toMatchObject({identityId,attemptId,body:'请保留现有接口\n并补充回归检查'});
  expect(posts[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(input).toHaveValue('');await expect(stream).toContainText('等待送达');
  await expect(stream.locator('[data-role="user"]')).toContainText('测试成员');
  messages[0].state='delivering';await expect(stream).toContainText('正在送达');
  messages[0].state='delivered';await expect(stream).toContainText('Agent 已接收，不代表已采纳');
  await input.fill('请继续检查权限边界');await input.press('Meta+Enter');
  await expect.poll(()=>posts.length).toBe(2);await expect(input).toHaveValue('');
  messages[1].state='unknown';messages[1].error='unconfirmed';
  await expect(stream).toContainText('送达未确认，请查看回复后再决定是否重新发送');
  messages.push({id:id(103),authorName:'测试成员',body:'这一条已被拒绝',state:'rejected',createdAt:'2026-10-24T08:00:02.000Z',error:'execution_ended'});
  await expect(stream).toContainText('执行已结束，未能送达');
  await expect(dialog.getByRole('button',{name:'重试上一条'})).toHaveCount(0);expect(posts).toHaveLength(2);
  await dialog.screenshot({path:testInfo.outputPath('conversation-send-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(input).toBeInViewport();await expect(dialog.getByRole('button',{name:'发送',exact:true})).toBeInViewport();
  await dialog.screenshot({path:testInfo.outputPath('conversation-send-mobile.png')});
});

test('task conversation retries the same uncertain message after reopening without clearing a newer draft',async({page,request})=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111',attemptId=id(92);
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'消息幂等重试'}})).json();
  const posts:any[]=[],messages:any[]=[];
  await page.route(`**/tasks/${taskId}/conversation/messages`,route=>{
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();posts.push(body);
      if(posts.length===1){messages.push({id:id(100),authorName:'测试成员',body:body.body,state:'queued',createdAt:'2026-10-24T08:00:01.000Z',error:null});return route.abort('failed');}
      return route.fulfill({json:{identityId,projectId,taskId,attemptId,message:messages[0]}});
    }
    return route.fulfill({json:{identityId,projectId,taskId,taskStatus:'running',attempt:{id:attemptId,state:'running',agentName:'代码助手',live:true,updatedAt:null,snapshot:null},messaging:{canSend:true,reason:null,messages}}});
  });
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  const entry=page.getByRole('button',{name:'实时对话',exact:true});await entry.click();
  let dialog=page.getByRole('dialog',{name:'实时对话'}),input=dialog.getByRole('textbox',{name:'给 Agent 发消息'});
  await input.fill('第一次补充');await dialog.getByRole('button',{name:'发送',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('提交结果尚未确认');await expect(input).toHaveValue('第一次补充');
  await input.fill('下一条草稿');await dialog.press('Escape');await entry.click();
  dialog=page.getByRole('dialog',{name:'实时对话'});input=dialog.getByRole('textbox',{name:'给 Agent 发消息'});
  await expect(input).toHaveValue('下一条草稿');await page.waitForTimeout(2200);expect(posts).toHaveLength(1);
  await dialog.getByRole('button',{name:'重试上一条',exact:true}).click();
  await expect.poll(()=>posts.length).toBe(2);expect(posts[1]).toEqual(posts[0]);
  await expect(dialog.getByRole('button',{name:'发送',exact:true})).toBeVisible();await expect(input).toHaveValue('下一条草稿');
  await expect(dialog.getByRole('log').locator('[data-role="user"]')).toHaveCount(1);
  await expect(dialog.getByRole('log')).toContainText('此轮对话尚未同步');
});

test('task conversation aborts pending sends on close and isolates attempts and task drafts',async({page,request})=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111';
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'隔离不同执行轮次'}})).json();
  const second=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(94),body:'另一项任务'}})).json();
  let attemptId=id(92),reason:string|null=null;const posts:any[]=[],releases:(()=>void)[]=[];
  for(const currentTask of [taskId,second.taskId])await page.route(`**/tasks/${currentTask}/conversation/messages`,async route=>{
    if(route.request().method()==='POST'){
      posts.push(route.request().postDataJSON());await new Promise<void>(resolve=>releases.push(resolve));
      return route.fulfill({status:503,json:{error:'Unavailable'}}).catch(()=>{});
    }
    return route.fulfill({json:{identityId,projectId,taskId:currentTask,taskStatus:reason==='not_running'?'review':'running',attempt:{id:attemptId,state:reason==='not_running'?'finished':'running',agentName:'代码助手',live:true,updatedAt:null,snapshot:null},messaging:{canSend:reason===null,reason,messages:[]}}});
  });
  const taskUrl=(task:string)=>`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${task}`;
  await page.goto(taskUrl(taskId));await page.getByRole('button',{name:'实时对话',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'实时对话'}),input=dialog.getByRole('textbox',{name:'给 Agent 发消息'});
  await input.fill('原轮次消息');await dialog.getByRole('button',{name:'发送',exact:true}).click();await expect.poll(()=>posts.length).toBe(1);
  const aborted=page.waitForEvent('requestfailed',r=>r.method()==='POST'&&r.url().endsWith('/conversation/messages'));
  await dialog.press('Escape');await aborted;releases.forEach(release=>release());
  await page.getByRole('button',{name:'实时对话',exact:true}).click();dialog=page.getByRole('dialog',{name:'实时对话'});input=dialog.getByRole('textbox',{name:'给 Agent 发消息'});
  await expect(input).toHaveValue('原轮次消息');await expect(dialog.getByRole('button',{name:'重试上一条'})).toBeVisible();expect(posts).toHaveLength(1);
  attemptId=id(93);await expect(input).toHaveValue('');await expect(dialog.getByRole('button',{name:'发送',exact:true})).toBeVisible();expect(posts).toHaveLength(1);
  await input.fill('新轮次草稿');
  for(const [value,text] of [['read_only','当前账号只有查看权限'],['offline','Runner 已离线'],['unavailable','尚未准备好接收消息'],['unsupported','不支持运行中接收消息'],['limit','本轮消息已达到上限'],['not_running','当前没有正在运行的执行']]){
    reason=value;await expect(dialog).toContainText(text);await expect(input).toBeDisabled();await expect(dialog.getByRole('button',{name:'发送',exact:true})).toBeDisabled();
  }
  await dialog.press('Escape');reason=null;await page.goto(taskUrl(second.taskId));await page.getByRole('button',{name:'实时对话',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('textbox',{name:'给 Agent 发消息'})).toHaveValue('');expect(posts).toHaveLength(1);
});

test('task conversation retains drafts after explicit rejection and rejects mismatched send receipts',async({page,request})=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111',attemptId=id(92);
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'校验消息提交边界'}})).json();
  let posts=0;
  await page.route(`**/tasks/${taskId}/conversation/messages`,route=>{
    if(route.request().method()==='POST'){
      posts++;if(posts===1)return route.fulfill({status:400,json:{error:'Invalid request'}});
      return route.fulfill({json:{identityId,projectId,taskId,attemptId:id(93),message:{id:id(100),authorName:'测试成员',body:'补充信息',state:'queued',createdAt:'2026-10-24T08:00:01.000Z',error:null}}});
    }
    return route.fulfill({json:{identityId,projectId,taskId,taskStatus:'running',attempt:{id:attemptId,state:'running',agentName:'代码助手',live:true,updatedAt:null,snapshot:null},messaging:{canSend:true,reason:null,messages:[]}}});
  });
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  await page.getByRole('button',{name:'实时对话',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'实时对话'}),input=dialog.getByRole('textbox',{name:'给 Agent 发消息'});
  await input.fill('补充信息');await dialog.getByRole('button',{name:'发送',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('当前无法发送，草稿已保留');await expect(input).toHaveValue('补充信息');
  await expect(dialog.getByRole('button',{name:'重试上一条'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'发送',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('无权读取');await expect(dialog.getByRole('log')).toHaveCount(0);await expect(input).toHaveCount(0);expect(posts).toBe(2);
});

test('task activity explains assessment reports and keeps tracking details collapsed',async({page,request},testInfo)=>{
  const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111';
  const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'支持需求附图及图片内容识别'}})).json();
  const attemptId='362ec1e5-fdfd-405c-9d7a-501b964fbe7b';
  const report=JSON.stringify({difficulty:4,risk:'high',confidence:0.78,rationale:'涉及图片上传、权限控制及 Agent 图片内容识别，需要验证完整流程。',requiredCapability:'coding'});
  const base={type:'operation',timestamp:'2026-10-24T06:40:25.000Z',actorType:'system',actorId:null,displayName:null,agentId:null,ownerName:null,inputRevision:1,attemptId,reviewStatus:null,fromState:null,toState:null};
  const events=[
    {...base,id:'publication:'+id(92),operation:'publication',body:'Task published',attemptId:null,toState:'pending'},
    {...base,id:'assigned:'+attemptId,operation:'assigned',body:'Assessment assigned'},
    {...base,id:'started:'+attemptId,operation:'started',body:'Assessment started',actorType:'agent',displayName:'项目总协调',ownerName:'测试成员'},
    {...base,id:'report:'+attemptId,operation:'assessment_report',body:report,actorType:'agent',displayName:'项目总协调',ownerName:'测试成员',reviewStatus:'approved'},
    {...base,id:'approval:'+attemptId,operation:'assessment_approval',body:'Assessment risk approved',actorType:'member',displayName:'测试成员',reviewStatus:'approved'},
    {...base,id:'assigned:'+id(93),operation:'assigned',body:'Execution assigned',fromState:'pending',toState:'assigned',attemptId:id(93)},
    {...base,id:'comment:'+id(94),operation:null,type:'comment',actorType:'member',displayName:'测试成员',body:'Task published',attemptId:null},
    {...base,id:'report:'+id(95),operation:'assessment_report',body:'{"difficulty":99,"risk":"high"}',inputRevision:null,attemptId:id(95),reviewStatus:'invalid'},
    {...base,id:'report:'+id(96),operation:'assessment_report',body:'TypeSafe：任务超出当前执行能力，请修订任务范围。',attemptId:id(96),reviewStatus:'invalid'},
    {...base,id:'report:'+id(97),operation:'assessment_report',body:'{"difficulty":',attemptId:id(97),reviewStatus:'invalid'},
    {...base,id:'comment:'+id(98),operation:null,type:'comment',actorType:'member',displayName:'测试成员',body:report,attemptId:null},
    {...base,id:'stopped:'+id(96),operation:'stopped',body:'Execution stopped',attemptId:id(96),reviewStatus:'failed'},
    {...base,id:'stopped:'+id(93),operation:'stopped',body:'Execution stopped',attemptId:id(93),toState:'failed',reviewStatus:'failed'},
  ];
  await page.route(`**/tasks/${taskId}/activity`,route=>route.fulfill({json:{identityId,projectId,taskId,items:[...events].reverse(),hasMore:false,nextCursor:null}}));
  await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
  const activity=page.getByRole('region',{name:'任务动态'}),entries=activity.locator('li');
  await expect(entries).toHaveCount(13);
  await expect(entries.nth(1)).toContainText('分配评估');
  await expect(entries.nth(2)).toContainText('开始评估');
  await expect(entries.nth(5)).toContainText('分配执行');
  await expect(activity.getByText('Assessment assigned',{exact:true})).not.toBeVisible();
  await expect(activity.getByText('Assessment risk approved',{exact:true})).not.toBeVisible();
  const assessment=entries.nth(3);
  await expect(assessment).toContainText('4 / 5');
  await expect(assessment).toContainText('78%');
  await expect(assessment.getByText('高',{exact:true})).toBeVisible();
  await expect(assessment).toContainText('涉及图片上传、权限控制');
  await expect(assessment.getByText(report,{exact:true})).not.toBeVisible();
  await expect(assessment.getByText(attemptId,{exact:true})).not.toBeVisible();
  // User-authored text must not be treated as a system event or assessment payload.
  await expect(entries.nth(6).getByText('Task published',{exact:true})).toBeVisible();
  await expect(entries.nth(7)).toContainText('无法整理');
  await expect(entries.nth(7).getByText(events[7].body,{exact:true})).not.toBeVisible();
  await expect(entries.nth(8).getByText(events[8].body,{exact:true}).first()).toBeVisible();
  await expect(entries.nth(8)).toContainText('评估无效');
  await expect(entries.nth(9)).toContainText('无法整理');
  await expect(entries.nth(10).getByText(report,{exact:true})).toBeVisible();
  await expect(entries.nth(11)).toContainText('评估停止');
  await expect(entries.nth(12)).toContainText('执行停止');
  await activity.scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('activity-desktop.png'),fullPage:true});
  const details=assessment.locator('summary');
  await details.focus();await details.press('Enter');
  await expect(assessment.getByText(attemptId,{exact:true})).toBeVisible();
  await expect(assessment).toContainText('任务内容版本');
  await expect(assessment.getByText(report,{exact:true})).toBeVisible();
  await entries.nth(5).locator('summary').click();
  await expect(entries.nth(5)).toContainText('待领取 → 已分配');
  await entries.nth(7).locator('summary').click();
  await expect(entries.nth(7)).toContainText('历史版本未记录');
  await expect(entries.nth(7).getByText(events[7].body,{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await assessment.scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('activity-mobile-details.png'),fullPage:true});
  await details.click();
  await page.screenshot({path:testInfo.outputPath('activity-mobile.png'),fullPage:true});
});

for(const manual of [false,true])test(`story decomposition ${manual?'preserves manual edits':'waits for and automatically fills the result'} during polling`,async({page,request})=>{
  const projectPath='/api/account/projects/'+id(11);
  const created=await request.post(projectPath+'/boards/'+id(21)+'/stories',{data:{requestId:id(91),title:'拆分稳定性',body:'保留用户正在填写的任务草稿。'}});
  const {story}=await created.json();
  let publicationReads=0,boardReads=0,ready=false;
  page.on('request',r=>{if(new URL(r.url()).pathname===projectPath+'/boards')boardReads++;});
  await page.route('**/stories/'+story.id+'/publications',route=>{publicationReads++;return route.fulfill({json:{publications:[],hasMore:false}});});
  await page.route('**/stories/'+story.id+'/assistance',route=>route.fulfill({json:{jobs:[{id:id(92),storyVersion:1,state:ready?'draft':'queued',version:ready?2:1,calls:ready?1:0,stale:false,issues:[],proposal:ready?{tasks:[{key:'task1',title:'已生成的任务',objective:'实现要求',acceptanceCriteria:'检查通过',requiredCapabilities:['coding'],priority:'normal',dependsOn:[]}]}:null}]}}));
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/stories');
  await page.getByRole('button',{name:'拆分稳定性',exact:true}).click();
  await page.getByRole('button',{name:'拆分任务',exact:true}).click();
  const title=page.getByLabel('任务 1 标题', {exact:false});
  await expect(title).toHaveCount(0);
  await expect(page.getByRole('button',{name:'完成拆分',exact:true})).toHaveCount(0);
  if(manual){
    await page.getByRole('button',{name:'手工拆分',exact:true}).click();
    await title.fill('编辑中的草稿');
  }
  const readsBefore=boardReads,publicationsBefore=publicationReads;
  await expect.poll(()=>boardReads,{timeout:6000}).toBeGreaterThanOrEqual(readsBefore+2);
  expect(publicationReads).toBe(publicationsBefore);
  if(manual){await expect(title).toBeEnabled();await expect(title).toBeFocused();await expect(title).toHaveValue('编辑中的草稿');}
  ready=true;
  if(manual){
    const apply=page.getByRole('button',{name:'采用 AI 草稿',exact:true});
    await expect(apply).toBeVisible();
    await expect(title).toHaveValue('编辑中的草稿');
    page.once('dialog',dialog=>dialog.dismiss());await apply.click();
    await expect(title).toHaveValue('编辑中的草稿');
    page.once('dialog',dialog=>dialog.accept());await apply.click();
  }
  await expect(title).toHaveValue('已生成的任务');
  await expect(title).not.toBeVisible();
  await page.locator('.publication-task > summary').click();
  await expect(page.getByLabel('任务 1 所需能力',{exact:true})).not.toBeVisible();
  await title.fill('核对后的任务');
  const after=boardReads;
  await expect.poll(()=>boardReads,{timeout:6000}).toBeGreaterThanOrEqual(after+3);
  await expect(title).toHaveValue('核对后的任务');
  await expect(title).toBeFocused();
  await page.reload();
  await expect(title).toHaveValue('核对后的任务');
  await expect(page.getByRole('button',{name:'完成拆分',exact:true})).toBeEnabled();
});

test('compact decomposition keeps details editable and validates hidden fields before publication',async({page,request},testInfo)=>{
  const path='/api/account/projects/'+id(11);
  const {story}=await(await request.post(path+'/boards/'+id(21)+'/stories',{data:{requestId:id(91),title:'图片与附件',body:'支持需求图片和附件下载。'}})).json();
  const tasks=[{key:'images',title:'支持需求图片',objective:'完成图片上传、授权访问与 Agent 图片识别，并验证完整流程。',acceptanceCriteria:'图片上传成功，获授权的 Agent 能读取图片内容。',requiredCapabilities:['coding'],priority:'normal',dependsOn:[]},
    {key:'attachments',title:'支持附件下载',objective:'允许成员下载需求附件，并校验访问权限。',acceptanceCriteria:'项目成员可以下载，非成员访问被拒绝。',requiredCapabilities:['coding'],priority:'normal',dependsOn:['images']}];
  let submitted:any;
  await page.route('**/stories/'+story.id+'/publications',async route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{publications:[],hasMore:false}});
    submitted=route.request().postDataJSON();
    return route.fulfill({json:{publication:{id:id(94),projectId:id(11),boardId:id(21),storyId:story.id,storyVersion:1,authorId:id(1),sourceStory:{title:story.title,body:story.body,version:1},tasks:submitted.tasks.map((task:any,index:number)=>({...task,id:id(95+index),status:'pending',dependsOn:task.dependsOn.map((key:string)=>id(95+submitted.tasks.findIndex((item:any)=>item.key===key)))}))}}});
  });
  await page.route('**/stories/'+story.id+'/assistance',route=>route.fulfill({json:{jobs:[{id:id(92),storyVersion:1,state:'draft',version:2,calls:1,stale:false,issues:[],proposal:{tasks}}]}}));
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/stories');
  await page.getByRole('button',{name:'图片与附件',exact:true}).click();
  await page.getByRole('button',{name:'拆分任务',exact:true}).click();
  const rows=page.locator('.publication-task > summary');
  await expect(rows).toHaveCount(2);
  await expect(page.getByLabel('任务 1 标题',{exact:true})).not.toBeVisible();
  await expect(page.getByRole('button',{name:'刷新发布记录'})).not.toBeVisible();
  await page.screenshot({path:testInfo.outputPath('compact-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('compact-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await rows.nth(0).press('Enter');
  await expect(page.getByLabel('任务 1 标题',{exact:true})).toBeVisible();
  await expect(page.getByLabel('任务 1 所需能力',{exact:true})).not.toBeVisible();
  await page.screenshot({path:testInfo.outputPath('editor-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('editor-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'添加任务',exact:true}).click();
  await expect(page.getByLabel('任务 3 标题',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'移除任务 3',exact:true}).click();
  await expect(rows).toHaveCount(2);
  await rows.nth(1).click();
  await expect(page.getByLabel('任务 1 标题',{exact:true})).not.toBeVisible();
  await page.locator('.publication-task').nth(1).getByText('更多设置',{exact:true}).click();
  await expect(page.getByLabel('任务 2 依赖任务 1',{exact:true})).toBeChecked();
  await page.getByLabel('任务 2 所需能力',{exact:true}).fill('');
  await rows.nth(1).click();
  await page.getByRole('button',{name:'完成拆分',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('请补齐任务信息');
  await expect(page.getByLabel('任务 2 所需能力',{exact:true})).toBeVisible();
  await page.getByLabel('任务 2 所需能力',{exact:true}).fill('coding');
  await page.getByRole('button',{name:'完成拆分',exact:true}).click();
  await expect(page.getByRole('button',{name:'确认发布任务',exact:true})).toBeDisabled();
  await page.getByLabel('我已确认故事版本和任务拆分',{exact:false}).check();
  await page.getByRole('button',{name:'确认发布任务',exact:true}).click();
  await expect(page.getByRole('region',{name:'发布结果'})).toContainText('已发布 2 项任务');
  expect(submitted.tasks).toEqual(tasks);
});

test('failed or stale decomposition keeps the empty editor hidden and does not adopt an older result',async({page,request})=>{
  const path='/api/account/projects/'+id(11);
  const {story}=await(await request.post(path+'/boards/'+id(21)+'/stories',{data:{requestId:id(91),title:'拆分失败恢复',body:'失败后保留恢复入口。'}})).json();
  const proposal={tasks:[{key:'task1',title:'旧任务',objective:'目标',acceptanceCriteria:'验收',requiredCapabilities:['writing'],priority:'normal',dependsOn:[]}]};
  let stale=false;
  await page.route('**/stories/'+story.id+'/publications',route=>route.fulfill({json:{publications:[],hasMore:false}}));
  await page.route('**/stories/'+story.id+'/assistance',route=>route.fulfill({json:{jobs:[
    {id:id(93),storyVersion:1,state:stale?'draft':'failed',version:2,calls:1,stale,issues:['Coordinator stopped; inspect the account and runtime before retrying'],proposal:stale?proposal:null},
    {id:id(92),storyVersion:1,state:'draft',version:2,calls:1,stale,issues:[],proposal},
  ]}}));
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/stories');
  await page.getByRole('button',{name:'拆分失败恢复',exact:true}).click();
  await page.getByRole('button',{name:'拆分任务',exact:true}).click();
  await expect(page.getByText(/协调执行已中断/)).toBeVisible();
  await expect(page.getByLabel('任务 1 标题')).toHaveCount(0);
  stale=true;
  await expect(page.getByText('故事已更新，请重新拆分',{exact:true})).toHaveCount(1);
  await expect(page.getByLabel('任务 1 标题')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'手工拆分',exact:true})).toBeEnabled();
});

test('board defers the editor until composing and keeps the dialog usable while it loads',async({page})=>{
  const editorRequests:string[]=[];
  page.on('request',request=>{if(/\/BodyEditorContent\.tsx(?:\?|$)|\/@tiptap_.*\.js(?:\?|$)/.test(request.url()))editorRequests.push(request.url());});
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/board');
  await expect(page.getByRole('heading',{name:'默认看板',exact:true})).toBeVisible();
  expect(editorRequests).toHaveLength(0);
  let release!:()=>void;
  const loading=new Promise<void>(resolve=>release=resolve);
  await page.route('**/BodyEditorContent.tsx*',async route=>{await loading;await route.continue();});
  try{
    await page.getByRole('button',{name:'新建故事',exact:true}).first().click();
    const dialog=page.getByRole('dialog',{name:'新建故事'});
    await expect(dialog.getByRole('status')).toContainText('正在加载正文编辑器');
    await dialog.getByLabel('故事标题').fill('等待加载时填写的标题');
    await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeEnabled();
    release();
    await dialog.getByRole('textbox',{name:'故事正文'}).fill('加载完成后继续填写正文。');
    await expect(dialog.getByLabel('故事标题')).toHaveValue('等待加载时填写的标题');
    await dialog.getByRole('button',{name:'创建故事',exact:true}).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('region',{name:'故事池列'})).toContainText('等待加载时填写的标题');
  }finally{release();}
});

test('failed editor download can retry without losing the composer title',async({page})=>{
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/board');
  await expect(page.getByRole('heading',{name:'默认看板',exact:true})).toBeVisible();
  let failed=false;
  await page.route('**/BodyEditorContent.tsx*',route=>{if(!failed){failed=true;return route.abort();}return route.continue();});
  const trigger=page.getByRole('button',{name:'新建故事',exact:true}).first();
  await trigger.click();
  const dialog=page.getByRole('dialog',{name:'新建故事'});
  await dialog.getByLabel('故事标题').fill('网络恢复后继续编辑');
  await expect(dialog.getByRole('alert')).toContainText('正文编辑器未能加载');
  await dialog.getByRole('button',{name:'重试加载',exact:true}).click();
  await dialog.getByRole('textbox',{name:'故事正文'}).fill('重试成功。');
  await expect(dialog.getByLabel('故事标题')).toHaveValue('网络恢复后继续编辑');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('API Key entered in the account dialog reaches only the local Runner',async({page})=>{
  const runnerId=id(41),identityId='11111111-1111-4111-8111-111111111111',calls:string[]=[];
  const bridge=await openLocalKeyBridge({origin:'http://127.0.0.1:'+(process.env.MAS_ACCOUNT_UI_PORT??'5198'),runnerId,add:async(_profile,label,key)=>{
    calls.push(key);return {id:id(91),label};
  }});
  try{
    await page.route('**/api/account/runner-local-config/**',route=>route.fulfill({status:200,contentType:'application/json',headers:{'X-MAS-Identity':identityId},body:JSON.stringify({identityId,runnerId,available:true,port:bridge.port,token:bridge.token})}));
    await page.goto('/#agents');
    await page.getByRole('button',{name:'查看 Agent：我的代码助手',exact:true}).click();
    const detail=page.getByRole('region',{name:'Agent 详情：我的代码助手',exact:true});
    await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
    await detail.getByRole('button',{name:'新增 API Key'}).click();
    const dialog=page.getByRole('dialog',{name:'新增 Codex API Key'});
    await dialog.getByLabel('账号名称').fill('工作 Key');
    await dialog.getByLabel('API Key').fill('sk-local-browser-test');
    await dialog.getByRole('button',{name:'保存到本机'}).click();
    await expect(dialog).toHaveCount(0);
    expect(calls).toEqual(['sk-local-browser-test']);
  }finally{await bridge.close();}
});

test('long Story body wraps inside the story list on desktop and narrow screens',async({page})=>{
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/board');
  await page.getByRole('button',{name:'新建故事',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'新建故事'});
  await dialog.getByLabel('故事标题').fill('长文本换行验收');
  await dialog.getByRole('textbox',{name:'故事正文'}).fill('这是一段需要在浏览器中自然换行的项目说明。'.repeat(12)+' https://example.com/'+('unbrokensegment'.repeat(20)));
  await dialog.getByRole('button',{name:'创建故事',exact:true}).click();
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/stories');
  const body=page.locator('.story-list .body-content');
  await expect(body).toBeVisible();
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:850});
    const layout=await body.evaluate(element=>{
      const span=element.querySelector('span')!;
      const range=document.createRange();range.selectNodeContents(span);
      return {whiteSpace:getComputedStyle(span).whiteSpace,lines:range.getClientRects().length,overflow:element.scrollWidth-element.clientWidth};
    });
    expect(layout.whiteSpace).not.toBe('nowrap');
    expect(layout.lines).toBeGreaterThan(1);
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

test('personal project configuration saves to read-only details and uses the shared repository',async({page,request})=>{
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/board');
  await page.getByRole('button',{name:'项目设置',exact:true}).click();
  const settings=page.getByRole('region',{name:'项目设置',exact:true});
  await settings.getByRole('tab',{name:'我的配置',exact:true}).click();
  const personal=settings.getByRole('region',{name:'我的配置',exact:true});
  await expect(personal.getByText('https://cnb.cool/pomona/demo',{exact:true})).toBeVisible();
  await expect(personal.getByLabel('代码仓库')).toHaveCount(0);
  await personal.getByLabel('本机工作目录').fill('/Users/tester/work/project');
  await personal.getByLabel('Git 用户名').fill('tester');
  await personal.getByLabel('Git 令牌').fill('fixture-personal-token');
  await personal.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await expect(personal.getByRole('button',{name:'编辑配置',exact:true})).toBeVisible();
  await expect(personal.getByLabel('本机工作目录')).toHaveCount(0);
  await expect(personal.getByText('/Users/tester/work/project',{exact:true})).toBeVisible();
  await expect(personal.getByText('fixture-personal-token')).toHaveCount(0);
  await expect(personal.getByRole('button',{name:'初始化',exact:true})).toBeEnabled();
  await page.reload();
  await expect(personal.getByRole('button',{name:'编辑配置',exact:true})).toBeVisible();
  await personal.getByRole('button',{name:'编辑配置',exact:true}).click();
  await expect(personal.getByLabel('Git 令牌')).toHaveValue('');
  await personal.getByLabel('本机工作目录').fill('/Users/tester/discard');
  await personal.getByRole('button',{name:'取消编辑',exact:true}).click();
  await expect(personal.getByText('/Users/tester/work/project',{exact:true})).toBeVisible();
  await personal.getByRole('button',{name:'编辑配置',exact:true}).click();
  await expect(personal.getByLabel('本机工作目录')).toHaveValue('/Users/tester/work/project');
  await personal.getByLabel('本机工作目录').fill('/Users/tester/work/new');
  await personal.getByLabel('Git 令牌').fill('fixture-replacement-token');
  await page.route('**/files/personal',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  await personal.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await expect(personal.getByRole('status')).toContainText('保存失败');
  await expect(personal.getByLabel('本机工作目录')).toHaveValue('/Users/tester/work/new');
  await expect(personal.getByLabel('Git 令牌')).toHaveValue('fixture-replacement-token');
  await page.unroute('**/files/personal');
  await personal.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await expect(personal.getByText('/Users/tester/work/new',{exact:true})).toBeVisible();
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`/private/tmp/mas-personal-readonly-${width}.png`,fullPage:true});
  }
  const updated=await request.post('/api/account/projects/'+id(11)+'/files',{data:{expectedVersion:1,agentsMd:'# Test',env:'REPO_URL=https://cnb.cool/pomona/updated\nDEFAULT_BRANCH=main\n'}});
  expect(updated.ok()).toBe(true);
  await page.reload();
  await expect(personal.getByText('https://cnb.cool/pomona/updated',{exact:true})).toBeVisible();
});

test('project working directory picker fills the field without saving it',async({page,request})=>{
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/board');
  await page.getByRole('button',{name:'项目设置',exact:true}).click();
  const settings=page.getByRole('region',{name:'项目设置',exact:true});
  await settings.getByRole('tab',{name:'我的配置',exact:true}).click();
  await settings.getByRole('button',{name:'选择目录',exact:true}).click();
  await expect(settings.getByLabel('本机工作目录')).toHaveValue('/Users/tester/work/chosen-folder');
  await expect(page.getByText('目录已选中，请保存我的配置。')).toBeVisible();
  await page.reload();
  await settings.getByRole('tab',{name:'我的配置',exact:true}).click();
  await expect(settings.getByLabel('本机工作目录')).toHaveValue('');
  await request.post('/__fixture/reset',{data:{mode:'offline-runner'}});
  await page.reload();
  await settings.getByRole('tab',{name:'我的配置',exact:true}).click();
  await expect(settings.getByRole('button',{name:'选择目录',exact:true})).toBeDisabled();
});

test('GitHub avatar opens editable profile; saves persist and the menu arrow points up',async({page,request})=>{
  await request.post('/__fixture/reset',{data:{mode:'github-profile'}});
  const png=await sharp({create:{width:256,height:256,channels:3,background:'#218876'}}).png().toBuffer();
  await page.route('https://avatars.githubusercontent.com/**',route=>route.fulfill({contentType:'image/png',body:png}));
  await page.goto('/');
  const avatar=page.getByRole('button',{name:'个人资料',exact:true});
  await expect(avatar.getByAltText('个人头像')).toBeVisible();
  expect(await avatar.getByAltText('个人头像').evaluate((node:HTMLImageElement)=>node.naturalWidth)).toBe(256);
  await expect(page.getByRole('button',{name:'用户菜单'}).locator('.lucide-chevron-up')).toHaveCount(1);
  await avatar.click();const dialog=page.getByRole('dialog',{name:'个人资料'});
  await expect(dialog.getByLabel('昵称')).toHaveValue('测试成员');
  await dialog.getByLabel('昵称').fill('我的 GitHub 昵称');await dialog.getByLabel('签名',{exact:true}).fill('把想法变成产品');
  await dialog.getByLabel('选择头像').setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:png});
  await expect(dialog.getByRole('button',{name:'保存',exact:true})).toBeEnabled();
  await page.screenshot({path:'artifacts/account-navigation/personal-profile-desktop.png',fullPage:true});
  await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(dialog).toHaveCount(0);
  await expect(page.locator('.profile-trigger')).toContainText('我的 GitHub 昵称');
  await page.reload();await expect(page.locator('.profile-trigger')).toContainText('我的 GitHub 昵称');
  await expect(avatar.getByAltText('个人头像')).toHaveAttribute('src','/api/account/profile/avatar/1');
  await avatar.click();await expect(dialog.getByLabel('签名',{exact:true})).toHaveValue('把想法变成产品');
  await dialog.getByLabel('昵称').fill('取消的昵称');await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await expect(avatar).toBeFocused();await expect(page.locator('.profile-trigger')).toContainText('我的 GitHub 昵称');
  await page.getByRole('button',{name:'用户菜单'}).click();await expect(page.getByRole('menuitem')).toHaveCount(2);
  await expect(page.getByRole('menuitem',{name:'组织管理'})).toBeVisible();await expect(page.getByRole('menuitem',{name:'退出系统'})).toBeVisible();
});

test('profile fits mobile, validates avatars, and retains edits after failed save',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await page.getByRole('button',{name:'个人资料',exact:true}).click();const dialog=page.getByRole('dialog',{name:'个人资料'});
  await expect(dialog.getByLabel('昵称')).toHaveValue('测试成员');
  await dialog.getByLabel('选择头像').setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(10*1024*1024+1)});
  await expect(dialog.getByRole('alert')).toContainText('10 MB');
  await dialog.getByLabel('选择头像').setInputFiles({name:'vector.svg',mimeType:'image/svg+xml',buffer:Buffer.from('<svg/>')});
  await expect(dialog.getByRole('alert')).toContainText('PNG、JPEG 或 WebP');
  await dialog.getByLabel('昵称').fill('手机上的昵称');await dialog.getByLabel('签名',{exact:true}).fill('产品与协作');
  let fail=true;await page.route('**/api/account/profile',async route=>{if(route.request().method()==='POST'&&fail){fail=false;await route.fulfill({status:503,json:{error:'Unavailable'}});}else await route.continue();});
  await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('保存失败');
  await expect(dialog.getByLabel('昵称')).toHaveValue('手机上的昵称');
  await page.screenshot({path:'artifacts/account-navigation/personal-profile-mobile.png',fullPage:true});
  const box=await dialog.boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{name:'个人资料',exact:true}).click();await expect(dialog.getByLabel('签名',{exact:true})).toHaveValue('产品与协作');
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
});

test('board creates a Story in one modal with pasted images and a body-only task in pending',async({page,context,request})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  const boardUrl=page.url();
  await page.getByRole('button',{name:'新建故事',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'新建故事'});
  await expect(dialog).toBeVisible();await expect(page).toHaveURL(boardUrl);
  await dialog.getByLabel('故事标题').fill('图片粘贴验收');
  await dialog.getByRole('textbox',{name:'故事正文'}).fill('第一段：描述故事。');
  const largePng=await sharp(randomBytes(1800*1800*3),{raw:{width:1800,height:1800,channels:3}}).png({compressionLevel:0}).toBuffer();
  await dialog.locator('input[type=file]').setInputFiles({name:'large.png',mimeType:'image/png',buffer:largePng});
  await expect(dialog.getByAltText('正文图片')).toBeVisible();
  await dialog.getByAltText('正文图片').click();await page.keyboard.press('Backspace');await expect(dialog.getByAltText('正文图片')).toHaveCount(0);
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=480;canvas.height=200;
    const ctx=canvas.getContext('2d')!;ctx.fillStyle='#e8f5ed';ctx.fillRect(0,0,480,200);ctx.fillStyle='#17734a';ctx.fillRect(22,28,136,142);ctx.fillStyle='#252735';ctx.font='24px sans-serif';ctx.fillText('Story image',184,106);
    const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));
    await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
  });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(dialog.getByAltText('正文图片')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'创建故事',exact:true})).toBeEnabled();
  await page.screenshot({path:'artifacts/account-navigation/story-composer-desktop.png',fullPage:true});
  await dialog.getByRole('button',{name:'创建故事',exact:true}).click();
  await expect(dialog).toHaveCount(0);await expect(page).toHaveURL(boardUrl);
  const storyColumn=page.getByRole('region',{name:'故事池列',exact:true});
  await expect(storyColumn.getByText('图片粘贴验收')).toBeVisible();
  await page.reload();await expect(storyColumn.getByAltText('正文图片')).toBeVisible();
  expect(await storyColumn.getByAltText('正文图片').evaluate((image:HTMLImageElement)=>image.naturalWidth)).toBe(480);
  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  const task=page.getByRole('dialog',{name:'新建任务'});
  await expect(task.getByRole('textbox')).toHaveCount(1);
  await expect(task.getByRole('button',{name:'创建任务',exact:true})).toBeDisabled();
  await task.getByRole('textbox',{name:'任务正文'}).fill('实现这张图中的需求');await page.keyboard.press('ControlOrMeta+v');
  await expect(task.getByAltText('正文图片')).toBeVisible();
  await task.getByRole('button',{name:'创建任务',exact:true}).click();
  await expect(task).toHaveCount(0);
  const pending=page.getByRole('region',{name:'待领取列',exact:true});await expect(pending.getByText('实现这张图中的需求')).toBeVisible();
  await page.reload();await expect(pending.getByAltText('正文图片')).toBeVisible();
  const state=await (await request.get('/__fixture/state')).json();
  const creates=state.requests.filter((r:{path:string;method:string})=>r.method==='POST'&&/\/boards\/[^/]+\/tasks$/.test(r.path));
  expect(creates).toHaveLength(1);expect(creates[0].body).not.toHaveProperty('title');
  await page.screenshot({path:'artifacts/account-navigation/board-created-work.png',fullPage:true});
  await pending.getByRole('button',{name:/实现这张图中的需求/}).click();
  await expect(page.locator('.task-detail-content').getByAltText('正文图片')).toBeVisible();
  expect(errors).toEqual([]);
});

test('composer fits mobile, cancels by Escape, and survives a failed save without duplicate task',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'新建故事',exact:true}).first().click();
  await page.getByLabel('故事标题').fill('手机故事');await page.getByRole('textbox',{name:'故事正文'}).fill('文字正文');
  await page.screenshot({path:'artifacts/account-navigation/story-composer-mobile.png',fullPage:true});
  const box=await page.getByRole('dialog').boundingBox();expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.x+box!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  const dialog=page.getByRole('dialog');await dialog.getByRole('textbox',{name:'任务正文'}).fill('保存结果重试');
  let fail=true;const ids:string[]=[];
  await page.route('**/boards/*/tasks',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    ids.push(route.request().postDataJSON().requestId);
    const response=await route.fetch();
    if(fail){fail=false;return route.fulfill({status:503,json:{error:'Unknown result'}});}await route.fulfill({response});
  });
  await dialog.getByRole('button',{name:'创建任务',exact:true}).click();
  await expect(dialog.getByRole('alert')).toBeVisible();await expect(dialog.getByRole('textbox')).toContainText('保存结果重试');
  await dialog.getByRole('button',{name:'创建任务',exact:true}).click();await expect(dialog).toHaveCount(0);
  expect(ids).toHaveLength(2);expect(ids[0]).toBe(ids[1]);await expect(page.getByText('保存结果重试',{exact:true})).toHaveCount(1);
});

test('viewers have no Story or task creation entry points',async({page,request})=>{
  await request.post('/__fixture/reset',{data:{mode:'viewer'}});await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await expect(page.getByRole('region',{name:'项目看板',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'新建故事',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'新建任务',exact:true})).toHaveCount(0);
});

test('board reaches viewport bottom with independent column scrolling and consistent workspace headings',async({page,request})=>{
  const samples:{font:string;weight:string;line:string}[]=[];
  const inspectHeading=async()=>{
    const header=page.locator('.workspace-page-heading').first();await expect(header).toBeVisible();
    samples.push(await header.locator('h1,h2,h3,h4').first().evaluate(el=>{const s=getComputedStyle(el);return {font:s.fontSize,weight:s.fontWeight,line:s.lineHeight};}));
    const subtitle=header.locator(':scope>div>span').first();
    if(await subtitle.count()){
      const title=await header.locator('h1,h2,h3,h4').first().boundingBox(),sub=await subtitle.boundingBox();
      expect(sub!.x).toBeGreaterThan(title!.x+title!.width);expect(sub!.y).toBeLessThan(title!.y+title!.height);
    }
  };
  await page.goto('/');await inspectHeading();
  for(const name of ['我的 Agent','管理 Runner','新建项目']){await page.getByRole('button',{name,exact:true}).click();await inspectHeading();}
  await page.goto('/#/organizations/'+id(1)+'/members');await inspectHeading();
  await page.goto('/#/organizations/'+id(1)+'/projects/'+id(11)+'/boards/'+id(21)+'/board');
  await expect(page.getByRole('region',{name:'项目看板',exact:true})).toBeVisible();await inspectHeading();
  for(const size of [{width:1440,height:1000},{width:1920,height:1080},{width:390,height:844}]){
    await page.setViewportSize(size);
    await expect.poll(async()=>{const box=await page.locator('.scrum-columns').boundingBox();return Math.abs(size.height-box!.y-box!.height);}).toBeLessThanOrEqual(2);
    await expect.poll(async()=>{const box=await page.locator('.scrum-column-body').first().boundingBox();return box!.height;}).toBeGreaterThan(80);
  }
  await page.setViewportSize({width:1440,height:1000});
  for(let n=0;n<15;n++)await request.post('/api/account/projects/'+id(11)+'/boards/'+id(21)+'/tasks',{data:{body:'任务正文 '+n+'：验证列内滚动。',requestId:id(500+n)}});
  await page.reload();const column=page.getByRole('region',{name:'待领取列',exact:true}).locator('.scrum-column-body');
  await expect(column.locator('.scrum-card')).toHaveCount(15);
  const head=await page.getByRole('heading',{name:'待领取',exact:true}).boundingBox();
  await column.evaluate(el=>el.scrollTop=el.scrollHeight);
  expect(await column.evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  expect(await page.getByRole('heading',{name:'待领取',exact:true}).boundingBox()).toEqual(head);
  await page.screenshot({path:'artifacts/account-navigation/board-full-height.png',fullPage:true});
  for(const name of ['项目协调Agent','成员管理','项目设置']){await page.getByRole('button',{name,exact:true}).click();await inspectHeading();}
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  await expect(page.getByRole('heading',{name:'项目配置',exact:true})).toBeVisible();
  await expect(page.getByText('https://cnb.cool/pomona/demo',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'我的配置',exact:true}).click();
  await page.getByLabel('本机工作目录').fill('/Users/tester/work/collaboration');
  await page.getByLabel('Git 用户名').fill('tester');
  await page.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await expect(page.getByText('我的配置已保存。')).toBeVisible();
  expect(samples.every(sample=>JSON.stringify(sample)===JSON.stringify(samples[0]))).toBe(true);
  await page.screenshot({path:'artifacts/account-navigation/settings-inline-heading.png',fullPage:true});
});

test('project configuration imports TCB variables, preserves edits and saves incomplete configuration',async({page,request})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'项目设置',exact:true}).click();
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  const region=page.getByRole('region',{name:'项目配置',exact:true});
  await expect(region.getByRole('textbox')).toHaveCount(0);
  await region.getByRole('button',{name:'编辑配置',exact:true}).click();
  await expect(region.getByLabel('代码仓库',{exact:true})).toBeFocused();
  await expect(region.getByLabel('代码仓库',{exact:true})).toHaveValue('https://cnb.cool/pomona/demo');
  const env='TCB_ENV_ID=fixture-env\nTCB_REGION=ap-shanghai\nAPI_KEY=test-private-key\n';
  await region.getByLabel('.deploy-access.env',{exact:true}).fill(env);
  await expect(region.getByLabel('代码仓库',{exact:true})).toHaveValue('');
  await expect(region.getByLabel('部署方式',{exact:true})).toHaveValue('tcb');
  await expect(region.getByLabel('服务器地址',{exact:true})).toHaveCount(0);
  await expect(region.getByLabel('TCB 环境 ID',{exact:true})).toHaveValue('fixture-env');
  await region.getByLabel('TCB 环境 ID',{exact:true}).fill('manual-env');
  await region.getByLabel('.deploy-access.env',{exact:true}).fill(env.replace('fixture-env','pasted-env').replace('ap-shanghai','ap-guangzhou'));
  await expect(region.getByLabel('TCB 环境 ID',{exact:true})).toHaveValue('manual-env');
  await expect(region.getByLabel('TCB 地域',{exact:true})).toHaveValue('ap-guangzhou');
  await expect(region.getByRole('button',{name:'保存修改',exact:true})).toHaveCount(1);
  await region.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(region.getByRole('status')).toHaveText('项目配置已保存。');
  await expect(region.getByRole('textbox')).toHaveCount(0);
  await expect(region.getByRole('button',{name:'保存修改',exact:true})).toHaveCount(0);
  await expect(region.getByRole('button',{name:'编辑配置',exact:true})).toBeFocused();
  await expect(region.getByText('manual-env',{exact:true})).toBeVisible();
  await expect(region).not.toContainText('test-private-key');
  const state=await (await request.get('/__fixture/state')).json();
  const saved=state.requests.filter((item:{path:string;method:string})=>item.path.endsWith('/files')&&item.method==='POST').at(-1).body;
  expect(saved.env).toContain('CLOUDBASE_ENV_ID="manual-env"');expect(saved.env).toContain('API_KEY=test-private-key');
  expect(saved.env).toContain('REPO_URL=""');
  await page.reload();
  await expect(region.getByRole('textbox')).toHaveCount(0);
  await region.getByRole('button',{name:'编辑配置',exact:true}).click();
  await expect(region.getByLabel('TCB 环境 ID',{exact:true})).toHaveValue('manual-env');
  await region.getByLabel('代码仓库',{exact:true}).fill('https://secret@cnb.cool/team/repo');
  await region.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(region.getByRole('status')).toContainText('代码仓库地址无效');
  await expect(region.getByLabel('代码仓库',{exact:true})).toHaveValue('https://secret@cnb.cool/team/repo');
  await region.getByLabel('代码仓库',{exact:true}).fill('');
  await region.getByLabel('TCB 环境 ID',{exact:true}).focus();
  const focus=await region.getByLabel('TCB 环境 ID',{exact:true}).evaluate(el=>({shadow:getComputedStyle(el).boxShadow,outline:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth}));
  expect(focus).toEqual({shadow:'none',outline:'solid',width:'2px'});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`artifacts/account-navigation/project-config-${viewport.width}.png`,fullPage:true});
  }
  await region.getByRole('button',{name:'取消编辑',exact:true}).click();
  await expect(region.getByRole('textbox')).toHaveCount(0);
  await region.getByRole('button',{name:'编辑配置',exact:true}).click();
  await expect(region.getByLabel('代码仓库',{exact:true})).toHaveValue('');
  await region.getByLabel('分支',{exact:true}).fill('release');
  let failSave=true;
  await page.route('**/api/account/projects/*/files',route=>route.request().method()==='POST'&&failSave?route.fulfill({status:503,json:{error:'Unavailable'}}):route.continue());
  await region.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(region.getByRole('status')).toContainText('项目配置未保存');
  await expect(region.getByLabel('分支',{exact:true})).toHaveValue('release');
  failSave=false;
  await region.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(region.getByRole('textbox')).toHaveCount(0);
  await expect(region.getByText('release',{exact:true})).toBeVisible();
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    await page.screenshot({path:`artifacts/account-navigation/project-config-saved-${viewport.width}.png`,fullPage:true});
  }
  await page.reload();
  await expect(region.getByRole('button',{name:'编辑配置',exact:true})).toBeVisible();
  await expect(region.getByRole('textbox')).toHaveCount(0);
  await expect(region.getByText('release',{exact:true})).toBeVisible();
});

test('first project configuration opens its editor and becomes read-only after saving',async({page,request})=>{
  await request.post('/__fixture/reset',{data:{mode:'unconfigured-project'}});
  await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'项目设置',exact:true}).click();
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  const region=page.getByRole('region',{name:'项目配置',exact:true});
  await expect(region.getByRole('button',{name:'保存修改',exact:true})).toBeVisible();
  await expect(region.getByRole('button',{name:'取消编辑',exact:true})).toHaveCount(0);
  await region.getByRole('button',{name:'保存修改',exact:true}).click();
  await expect(region.getByRole('status')).toHaveText('项目配置已保存。');
  await expect(region.getByRole('textbox')).toHaveCount(0);
  await region.getByRole('button',{name:'编辑配置',exact:true}).click();
  await expect(region.getByLabel('分支',{exact:true})).toHaveValue('main');
});

test('invitation returns after GitHub navigation and clears its temporary return token',async({page,request})=>{
  await request.post('/__fixture/reset',{data:{mode:'signed-out'}});
  await page.route('https://github.com/login/oauth/authorize?client_id=fixture',route=>route.fulfill({contentType:'text/html',body:'<p>OAuth fixture</p>'}));
  await page.goto('/#join-invite='+'b'.repeat(64));
  await page.getByRole('button',{name:/GitHub/}).click();
  await expect(page).toHaveURL(/github.com\/login\/oauth\/authorize/);
  await request.post('/api/identity/sign-in/email',{data:{email:'fixture@example.test',password:'fixture'}});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'组织邀请'})).toBeVisible();
  expect(await page.evaluate(()=>sessionStorage.getItem('mas.invitation.oauth-return'))).toBeNull();
  await page.getByRole('button',{name:'我的项目',exact:true}).click();
  await expect(page.getByRole('heading',{name:'我的项目',exact:true})).toBeVisible();
});

test('project membership selects organization users and preserves four role semantics',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'成员管理',exact:true}).click();
  await expect(page.getByRole('cell',{name:'项目负责人',exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'选择组织用户',exact:true}).selectOption(id(61));
  await page.getByRole('combobox',{name:'项目角色',exact:true}).selectOption('viewer');
  await page.getByRole('button',{name:'添加成员',exact:true}).click();
  await expect(page.getByLabel('设计同事的角色')).toHaveValue('viewer');
  await page.getByLabel('设计同事的角色').selectOption('manager');
  await expect(page.getByLabel('设计同事的角色')).toHaveValue('manager');
  await page.reload();await expect(page.getByLabel('设计同事的角色')).toHaveValue('manager');
  await page.screenshot({path:'artifacts/account-navigation/project-members.png',fullPage:true});
  await page.getByRole('button',{name:'移除设计同事'}).click();
  await expect(page.getByRole('dialog')).toContainText('移出项目');
  await page.getByRole('dialog').getByRole('button',{name:'移出成员',exact:true}).click();
  await expect(page.getByLabel('设计同事的角色')).toHaveCount(0);
  await page.getByRole('combobox',{name:'选择组织用户',exact:true}).selectOption(id(61));
  await page.getByRole('button',{name:'添加成员',exact:true}).click();
  await expect(page.getByLabel('设计同事的角色')).toBeVisible();
});

test('viewer can read member table but has no management controls',async({page,request})=>{
  await request.post('/__fixture/reset',{data:{mode:'viewer'}});
  await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'成员管理',exact:true}).click();
  await expect(page.getByRole('cell',{name:'只读成员',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'添加成员',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'项目设置',exact:true})).toHaveCount(0);
  await page.reload();await expect(page.getByRole('heading',{name:'项目成员',exact:true})).toBeVisible();
});

test('organization list, add/remove and bounded invitation dialog work on desktop and mobile',async({page,context})=>{
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.goto('/#/organizations/'+id(1)+'/members');
  await expect(page.getByRole('cell',{name:'组织创建者',exact:true})).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await page.getByRole('button',{name:'添加成员',exact:true}).click();
  await page.getByLabel('用户邮箱').fill('new-user@example.test');
  await page.getByRole('dialog').getByRole('button',{name:'添加成员',exact:true}).click();
  await expect(page.getByRole('cell',{name:'new-user',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'移除new-user'}).click();
  await expect(page.getByRole('dialog')).toContainText('移出组织');
  await page.getByRole('dialog').getByRole('button',{name:'移出成员',exact:true}).click();
  await expect(page.getByRole('cell',{name:'new-user',exact:true})).toHaveCount(0);
  await page.screenshot({path:'artifacts/account-navigation/organization-members.png',fullPage:true});
  await page.getByRole('button',{name:'邀请成员',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('img',{name:'组织邀请二维码'})).toBeVisible();
  const initialUrl=await dialog.getByLabel('邀请链接',{exact:true}).inputValue();
  await page.getByLabel('邀请人数',{exact:true}).fill('20');await page.getByLabel('邀请有效期（小时）',{exact:true}).fill('48');
  await expect(dialog.getByRole('img',{name:'组织邀请二维码'})).toHaveCount(0);
  await expect(dialog.getByLabel('邀请链接',{exact:true})).not.toHaveValue(initialUrl);
  await expect(dialog.getByText('邀请成员上限 20 位')).toBeVisible();
  await expect(dialog.getByRole('img',{name:'组织邀请二维码'})).toBeVisible();
  expect(await dialog.locator('.invitation-qr path').count()).toBeGreaterThan(0);
  await dialog.locator('.invitation-qr').screenshot({path:'artifacts/account-navigation/invitation-qr.png'});
  await page.getByRole('button',{name:'复制邀请链接'}).click();
  await expect(page.getByRole('button',{name:'已复制'})).toBeVisible();
  const url=await page.evaluate(()=>navigator.clipboard.readText());expect(url).toMatch(/#join-invite=[a-f0-9]{64}$/);
  await test.info().attach('invitation-url',{body:url,contentType:'text/plain'});
  await page.screenshot({path:'artifacts/account-navigation/invitation-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const box=await dialog.boundingBox();expect(box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({path:'artifacts/account-navigation/invitation-mobile.png',fullPage:true});
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button',{name:'邀请成员',exact:true})).toBeFocused();
  await page.goto(url);await expect(page.getByRole('heading',{name:'组织邀请'})).toBeVisible();
  await page.getByRole('button',{name:'接受邀请'}).click();await expect(page.getByText('你已加入该组织。')).toBeVisible();
});

test('invitation generation retries the same receipt and ignores outdated settings responses',async({page})=>{
  const inputs:{token:string;requestId:string;maxUses:number;hours:number}[]=[];
  let releaseOld!:()=>void;
  const oldResponse=new Promise<void>(resolve=>{releaseOld=resolve;});
  await page.route('**/invite-links',async route=>{
    const input=route.request().postDataJSON();inputs.push(input);
    if(inputs.length===1)return route.fulfill({status:503,json:{error:'Unavailable'}});
    if(inputs.length===2)await oldResponse;
    await route.fulfill({json:{link:{id:id(80),expiresAt:'2027-01-01T00:00:00Z',maxUses:input.maxUses,approvalRequired:false}}});
  });
  await page.goto('/#/organizations/'+id(1)+'/members');
  await page.getByRole('button',{name:'邀请成员',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('alert')).toHaveText('邀请未能生成，请重试。');
  await expect(dialog.getByRole('img',{name:'组织邀请二维码'})).toHaveCount(0);
  await dialog.getByRole('button',{name:'重新生成',exact:true}).click();
  await expect.poll(()=>inputs.length).toBe(2);
  expect(inputs[1]).toEqual(inputs[0]);
  await dialog.getByLabel('邀请人数',{exact:true}).fill('20');
  await expect(dialog.getByRole('img',{name:'组织邀请二维码'})).toBeVisible();
  expect(inputs).toHaveLength(3);expect(inputs[2].maxUses).toBe(20);
  const url=await dialog.getByLabel('邀请链接',{exact:true}).inputValue();
  expect(url).toContain(inputs[2].token);expect(inputs[2].requestId).not.toBe(inputs[1].requestId);
  const finished=page.waitForResponse(response=>response.url().endsWith('/invite-links')&&response.request().postDataJSON().token===inputs[1].token);
  releaseOld();await finished;
  await expect(dialog.getByLabel('邀请链接',{exact:true})).toHaveValue(url);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('organization members can invite and invitation survives sign-in with pending approval',async({page,request})=>{
  await page.goto('/#/organizations/'+id(2)+'/members');
  await expect(page.getByRole('button',{name:'添加成员',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^移除/})).toHaveCount(0);
  await page.getByRole('button',{name:'邀请成员',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('需组织创建者审核');
  await page.keyboard.press('Escape');
  await request.post('/__fixture/reset',{data:{mode:'signed-out'}});
  const hash='#join-invite='+'a'.repeat(64);await page.goto('/'+hash);await page.reload();
  await page.getByLabel('邮箱',{exact:true}).fill('fixture@example.test');await page.getByLabel('密码',{exact:true}).fill('fixture-password-only');
  await page.getByRole('form',{name:'登录工作空间'}).getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('heading',{name:'组织邀请'})).toBeVisible();
  await expect(page).toHaveURL(new RegExp(hash+'$'));
  await page.getByRole('button',{name:'接受邀请'}).click();await expect(page.getByText('已提交，等待组织创建者审核。')).toBeVisible();
});

test('home aggregates organizations and project navigation stays scoped across refresh and history', async ({page}) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', {name: '工作台导航'}).getByRole('button')).toHaveText(['新建项目', '我的项目', '我的 Agent', '管理 Runner']);
  const productGroup=page.getByRole('region', {name: '组织项目：product-team'});
  await expect(productGroup.getByRole('heading', {name: '产品研发', exact: true})).toBeVisible();
  await expect(productGroup).toContainText('product-team');
  await expect(productGroup.getByRole('button', {name: '打开项目：协作工作台'})).toBeVisible();
  await expect(page.getByRole('region', {name: '组织项目：design-team'}).getByRole('button', {name: '打开项目：设计系统'})).toBeVisible();
  await page.getByRole('button', {name: '打开项目：协作工作台'}).click();
  await expect(page.getByRole('navigation', {name: '项目导航'})).toBeVisible();
  await expect(page.getByRole('navigation', {name: '工作台导航'})).toHaveCount(0);
  await expect(page.getByRole('button', {name: '新建项目', exact: true})).toHaveCount(0);
  await page.getByLabel('切换项目').selectOption(id(12));
  await expect(page.getByRole('navigation', {name: '当前位置'})).toHaveCount(0);
  await expect(page.getByLabel('切换项目')).toHaveValue(id(12));
  await page.reload();
  await expect(page.getByLabel('切换项目')).toHaveValue(id(12));
  await page.getByRole('button', {name: '所有项目', exact: true}).click();
  await expect(page.getByRole('heading', {name: '我的项目', exact: true})).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel('切换项目')).toHaveValue(id(12));
});

test('create project selects organization, isolates drafts, and reuses receipt after failure', async ({page, request}) => {
  await page.goto('/#/projects/new');
  await expect(page.getByLabel('所属组织')).toHaveValue('');
  await expect(page.getByRole('button', {name: '创建项目', exact: true})).toBeDisabled();
  await page.getByLabel('所属组织').selectOption(id(2));
  await page.getByLabel('项目 KEY').fill('NEXT');
  await page.getByLabel('项目名称').fill('新建测试项目');
  await page.getByLabel('所属组织').selectOption(id(1));
  await expect(page.getByLabel('项目名称')).toHaveValue('');
  await page.getByLabel('所属组织').selectOption(id(2));
  await expect(page.getByLabel('项目名称')).toHaveValue('新建测试项目');
  await request.post('/__fixture/fail-create');
  await page.getByRole('button', {name: '创建项目', exact: true}).click();
  await expect(page.getByRole('alert')).toContainText('项目创建未能确认');
  await page.getByRole('button', {name: '创建项目', exact: true}).click();
  await expect(page.getByLabel('切换项目').locator('option:checked')).toHaveText('新建测试项目');
  const state = await (await request.get('/__fixture/state')).json();
  const posts = state.requests.filter((r: {method: string; path: string}) => r.method === 'POST' && r.path.endsWith('/projects'));
  expect(posts).toHaveLength(2);
  expect(posts[0].path).toBe('/api/account/organizations/' + id(2) + '/projects');
  expect(posts[0].body.requestId).toBe(posts[1].body.requestId);
  await page.getByRole('button', {name: '所有项目', exact: true}).click();
  await expect(page.getByRole('region', {name: '组织项目：design-team'})).toContainText('新建测试项目');
});

test('single organization defaults and no organization offers organization management', async ({page, request}) => {
  await request.post('/__fixture/reset', {data: {mode: 'single'}});
  await page.goto('/#/projects/new');
  await expect(page.getByLabel('所属组织')).toHaveValue(id(1));
  await request.post('/__fixture/reset', {data: {mode: 'empty'}});
  await page.reload();
  await expect(page.getByRole('button', {name: '组织管理', exact: true})).toBeVisible();
  await expect(page.getByRole('form', {name: '创建项目'})).toHaveCount(0);
});

test('profile menu, organization information, join requests, invitations, and sign-out', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: '用户菜单'}).click();
  await expect(page.getByRole('menuitem')).toHaveText(['组织管理', '退出系统']);
  await page.getByRole('menuitem', {name: '组织管理'}).click();
  await expect(page.getByRole('heading', {name: '组织管理', exact: true})).toBeVisible();
  await page.getByRole('button', {name: '组织信息：product-team'}).click();
  await expect(page.getByRole('heading', {name: '组织信息', exact: true})).toBeVisible();
  await page.getByRole('button', {name: '用户菜单'}).click();
  await page.getByRole('menuitem', {name: '组织管理'}).click();
  await page.getByRole('button', {name: '申请加入组织', exact: true}).click();
  await page.getByLabel('组织标识').fill('research-team');
  await page.getByRole('button', {name: '提交申请'}).click();
  await expect(page.getByRole('status')).toContainText('申请已提交');
  await page.getByRole('button', {name: '待处理的邀请'}).click();
  await page.getByRole('button', {name: '接受邀请'}).click();
  await page.getByRole('button', {name: '已加入的组织'}).click();
  await expect(page.getByRole('button', {name: '组织信息：research-team'})).toBeVisible();
  await page.getByRole('button', {name: '新建组织', exact: true}).click();
  const createForm=page.getByRole('form',{name:'创建组织'});
  await createForm.getByLabel('组织标识', {exact: true}).fill('new-team');
  await createForm.getByLabel('组织名称', {exact: true}).fill('新建团队');
  await createForm.getByRole('button', {name: '创建组织', exact: true}).click();
  await expect(page.getByRole('button', {name: '组织信息：new-team'})).toBeVisible();
  await page.getByRole('button', {name: '用户菜单'}).click();
  await page.getByRole('menuitem', {name: '退出系统'}).click();
  await expect(page.getByRole('form', {name: '登录工作空间'})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('form', {name: '登录工作空间'})).toBeVisible();
});

test('personal agent creation is absent from project grants and global settings stay outside projects', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: '打开项目：协作工作台'}).click();
  await expect(page.getByRole('button', {name: '项目自动执行', exact: true})).toHaveCount(0);
  await expect(page.getByRole('button', {name: '打开项目设置', exact: true})).toHaveCount(0);
  await page.getByRole('button', {name: '项目协调Agent', exact: true}).click();
  await expect(page.getByRole('radio', {name: /我的文档助手/})).toBeVisible();
  await expect(page.getByRole('button', {name: '添加 Agent', exact: true})).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByLabel('同时执行上限')).toHaveCount(0);
  await page.getByRole('radio', {name: /我的文档助手/}).check();
  await page.getByRole('button', {name: '保存授权'}).click();
  await expect(page.getByRole('status')).toContainText('协调授权已保存');
  await expect(page.getByRole('radio', {name: /我的文档助手.*当前授权/})).toBeChecked();
  await page.getByRole('button', {name: '所有项目', exact: true}).click();
  await page.getByRole('button', {name: '我的 Agent', exact: true}).click();
  await page.getByRole('button', {name: '添加 Agent', exact: true}).click();
  await expect(page.getByRole('form', {name: '创建 Agent', exact: true})).toBeVisible();
  await page.getByLabel('Agent 名称').fill('个人新助手');
  await page.getByRole('button', {name: '创建 Agent', exact: true}).click();
  await expect(page.getByRole('button', {name: '查看 Agent：个人新助手',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', {name: '查看 Agent：个人新助手',exact:true})).toBeVisible();
});

test('coordinator has one selection, conflict recovery, record tabs and owner-only controls', async ({page,request})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'项目协调Agent',exact:true}).click();
  await expect(page.getByRole('radio')).toHaveCount(3);
  await expect(page.getByRole('radio',{name:/未启用助手/})).toBeDisabled();
  await expect(page.getByRole('button',{name:'保存授权'})).toBeDisabled();
  await page.getByRole('radio',{name:/我的文档助手/}).check();
  await page.getByRole('button',{name:'保存授权'}).click();
  await expect(page.getByRole('status')).toContainText('协调授权已保存');
  await page.getByRole('radio',{name:/我的代码助手/}).check();
  await page.getByRole('button',{name:'保存授权'}).click();
  await expect(page.getByRole('radio',{name:/我的代码助手.*当前授权/})).toBeChecked();
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('radio',{name:/我的代码助手/})).toBeChecked();
  await page.getByRole('tab',{name:'执行记录'}).click();
  await expect(page.getByRole('tabpanel')).toContainText('尚未发布任务');
  await page.reload();
  await expect(page.getByRole('tab',{name:'执行记录'})).toHaveAttribute('aria-selected','true');
  await page.goBack();
  await expect(page.getByRole('tab',{name:'授权配置'})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('button',{name:'项目协调Agent',exact:true})).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await page.screenshot({path:'artifacts/account-navigation/desktop-coordinator.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/account-navigation/mobile-coordinator.png',fullPage:true});
  await page.getByLabel('切换项目').selectOption(id(12));
  await page.getByRole('button',{name:'项目协调Agent',exact:true}).click();
  await expect(page.locator('.workspace-page-heading')).toContainText('设计项目创建者');
  for(const radio of await page.getByRole('radio').all())await expect(radio).toBeDisabled();
  await expect(page.getByRole('button',{name:'保存授权'})).toHaveCount(0);
  await request.post('/__fixture/reset');
  await page.goto('/');
  await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'项目协调Agent',exact:true}).click();
  await page.getByRole('radio',{name:/我的文档助手/}).check();
  await request.post('/__fixture/coordinator-conflict');
  await page.getByRole('button',{name:'保存授权'}).click();
  await expect(page.getByRole('status')).toContainText('协调配置已变化');
  await expect(page.getByRole('radio',{name:/我的代码助手/})).toBeChecked();
});

test('sign-in always opens home and keyboard profile menu closes on Escape', async ({page, request}) => {
  await request.post('/__fixture/reset', {data: {mode: 'signed-out'}});
  await page.goto('/#/organizations');
  await page.getByLabel('邮箱', {exact: true}).fill('fixture@example.test');
  await page.getByLabel('密码', {exact: true}).fill('fixture-password-only');
  await page.getByRole('form', {name: '登录工作空间'}).getByRole('button', {name: '登录', exact: true}).click();
  await expect(page.getByRole('heading', {name: '我的项目', exact: true})).toBeVisible();
  await page.getByRole('button', {name: '用户菜单'}).click();
  await expect(page.getByRole('menuitem', {name: '组织管理'})).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', {name: '退出系统'})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button', {name: '用户菜单'})).toBeFocused();
  await page.screenshot({path: 'artifacts/account-navigation/desktop-home.png', fullPage: true});
});

test('partial failure preserves other organizations and narrow screens do not overflow', async ({page, request}) => {
  await request.post('/__fixture/reset', {data: {mode: 'partial-error'}});
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.getByRole('button', {name: '打开项目：协作工作台'})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('项目暂时无法加载');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({path: 'artifacts/account-navigation/mobile.png', fullPage: true});
  await page.getByRole('button', {name: '打开项目：协作工作台'}).click();
  await expect(page.getByRole('navigation', {name: '项目导航'})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('single board navigation and coordinator cards display model and live readiness',async({page,request})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  const nav=page.getByRole('navigation',{name:'项目导航'});
  await expect(nav.getByRole('button')).toHaveText(['Scrum 看板','项目协调Agent','成员管理','项目设置']);
  await nav.getByRole('button',{name:'项目设置',exact:true}).click();
  await expect(page.getByRole('button',{name:'创建看板',exact:true})).toHaveCount(0);
  const settings=page.getByRole('region',{name:'项目设置',exact:true});
  const tabs=settings.getByRole('tab');
  await expect(tabs).toHaveText(['基础信息','项目配置','我的配置']);
  await expect(settings.getByRole('tab',{name:'基础信息',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(settings.getByLabel('项目 Key（不可修改）')).toBeVisible();
  await expect(page.getByLabel('项目 Key（不可修改）')).toBeDisabled();
  await expect(page.getByLabel('项目 Key（不可修改）')).toHaveValue('SCRUM');
  await expect(settings.getByRole('button',{name:'保存',exact:true})).toBeVisible();
  await expect(page.locator('.account-content .back-link,.workspace-topbar,.breadcrumbs')).toHaveCount(0);
  await page.screenshot({path:'artifacts/account-navigation/project-settings-desktop.png',fullPage:true});
  await page.getByLabel('名称',{exact:true}).fill('新的项目名称');
  await page.getByLabel('描述',{exact:true}).fill('新的项目描述\n支持多行');
  await settings.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('项目信息已保存');
  await page.reload();
  await expect(page.getByLabel('名称',{exact:true})).toHaveValue('新的项目名称');
  await expect(page.getByLabel('描述',{exact:true})).toHaveValue('新的项目描述\n支持多行');
  await settings.getByRole('tab',{name:'项目配置',exact:true}).click();
  await expect(settings.getByRole('heading',{name:'项目配置',exact:true})).toBeVisible();
  await expect(page.getByText('https://cnb.cool/pomona/demo',{exact:true})).toBeVisible();
  await settings.getByRole('tab',{name:'我的配置',exact:true}).click();
  await expect(settings.getByRole('heading',{name:'我的配置',exact:true,level:2})).toBeVisible();
  await expect(settings.getByRole('button',{name:'初始化',exact:true})).toHaveCount(0);
  await page.getByLabel('本机工作目录').fill('/Users/tester/work/collaboration');
  await page.getByLabel('Git 用户名').fill('tester');
  await settings.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await expect(page.getByText('我的配置已保存。')).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/account-navigation/project-settings-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await nav.getByRole('button',{name:'项目协调Agent',exact:true}).click();
  await expect(page.getByRole('button',{name:'刷新配置'})).toHaveCount(0);
  const card=page.locator('.coordinator-card').filter({hasText:'我的文档助手'});
  await expect(card.locator('.agent-card-heading')).toHaveText('我的文档助手正常');
  await expect(card).toContainText('DSH');await expect(card).toContainText('deepseek-v4-flash');
  await page.getByRole('radio',{name:/我的文档助手/}).check();
  await page.getByRole('button',{name:'保存授权'}).click();
  await expect(card.locator('.agent-card-heading')).toHaveText('我的文档助手正常当前授权');
  await request.post('/__fixture/agent-offline');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(card.locator('.agent-card-heading')).toHaveText('我的文档助手未就绪当前授权');
  await expect(card.getByRole('group',{name:'我的文档助手就绪检查'})).toContainText('×Runner');
  await expect(page.locator('.coordinator-card').filter({hasText:'未启用助手'})).toContainText('未启用');
  await page.screenshot({path:'artifacts/account-navigation/desktop-coordinator-cards.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/account-navigation/mobile-coordinator-cards.png',fullPage:true});
});

test('personal agent list preserves account actions and creation lives in a closing subtab',async({page,request})=>{
  await page.goto('/#agents');
  await expect(page.locator('.personal-agent-row')).toHaveCount(3);
  const row=page.getByRole('button',{name:'查看 Agent：我的文档助手',exact:true});
  await row.click();
  let detail=page.getByRole('region',{name:'Agent 详情：我的文档助手',exact:true});
  await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  await detail.getByLabel('模型',{exact:true}).selectOption('deepseek-v4-pro');
  await detail.getByLabel('最高难度').selectOption('3');
  await detail.getByLabel('最高难度').selectOption('5');
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(row).toContainText('deepseek-v4-pro');
  const savedState=await (await request.get('/__fixture/state')).json();
  expect(savedState.requests.filter((r:{path:string;method:string})=>r.path==='/api/account/agent-settings'&&r.method==='POST').at(-1).body.agents[0].routing).toEqual({expectedVersion:1,difficultyMin:1,difficultyMax:5,preference:'balanced',relativeCost:2});
  await request.post('/__fixture/agent-executor-unavailable');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByRole('button',{name:'查看 Agent：我的代码助手',exact:true}).click();
  detail=page.getByRole('region',{name:'Agent 详情：我的代码助手',exact:true});
  await expect(detail.getByRole('group',{name:'我的代码助手就绪检查'})).toContainText('×Codex');
  await expect(detail.getByRole('button',{name:'新增 API Key'})).toHaveCount(0);
  await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  await detail.getByRole('button',{name:'新增 API Key'}).click();
  const accountDialog=page.getByRole('dialog',{name:'新增 Codex API Key'});
  await expect(accountDialog).toBeVisible();
  expect(await accountDialog.evaluate(element=>{const r=element.getBoundingClientRect();return Math.abs(r.left+r.width/2-innerWidth/2)<2&&Math.abs(r.top+r.height/2-innerHeight/2)<2;})).toBe(true);
  await expect(accountDialog.getByRole('button',{name:'保存到本机'})).toBeDisabled();
  await accountDialog.getByRole('button',{name:'取消'}).click();
  await expect(detail.getByRole('button',{name:'订阅账号登录'})).toHaveCount(0);
  await expect(detail.getByLabel('模型',{exact:true}).locator('optgroup[label="OpenAI"] option')).toHaveText(['6 Astra','6 Sol','6 Luna','5.6 Sol','5.6 Terra · 默认','5.6 Luna','5.5']);
  await detail.getByLabel('使用账号',{exact:true}).selectOption(id(91));
  let state=await (await request.get('/__fixture/state')).json();
  expect(state.agents.find((a:{id:string})=>a.id===id(32)).credentialId).toBe('legacy');
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(detail).toContainText('工作账号');
  await row.click();detail=page.getByRole('region',{name:'Agent 详情：我的文档助手',exact:true});
  await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  await detail.getByLabel('启用 Agent',{exact:true}).uncheck();
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(row.locator('.agent-status')).toHaveText('未启用');
  await page.screenshot({path:'artifacts/account-navigation/desktop-personal-agents.png',fullPage:true});
  await page.getByRole('button',{name:'添加 Agent',exact:true}).click();
  await expect(page.getByRole('tab',{name:'新增 Agent',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('button',{name:'新增 API Key'})).toBeVisible();
  await expect(row).toHaveCount(0);
  await page.getByLabel('Agent 名称').fill('列表创建助手');
  await page.getByRole('tab',{name:'Agent 列表'}).click();await expect(row).toBeVisible();
  await page.getByRole('tab',{name:'新增 Agent',exact:true}).click();
  await expect(page.getByLabel('Agent 名称')).toHaveValue('列表创建助手');
  await page.reload();await expect(page.getByLabel('Agent 名称')).toHaveValue('列表创建助手');
  await page.getByRole('button',{name:'创建 Agent',exact:true}).click();
  await expect(page.getByRole('tab',{name:'新增 Agent',exact:true})).toHaveCount(0);
  const created=page.getByRole('button',{name:'查看 Agent：列表创建助手',exact:true});
  await created.click();detail=page.getByRole('region',{name:'Agent 详情：列表创建助手',exact:true});
  await detail.getByRole('button',{name:'删除 Agent',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('历史执行记录仍会保留');
  await page.getByRole('dialog').getByRole('button',{name:'删除 Agent',exact:true}).click();
  await expect(created).toHaveCount(0);
  await row.click();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'artifacts/account-navigation/mobile-personal-agents.png',fullPage:true});
});

test('missing Runner opens standalone management and creation draft survives configuration',async({page,request})=>{
  await request.post('/__fixture/reset',{data:{mode:'no-runner'}});
  await page.goto('/#agents');
  await page.getByRole('button',{name:'添加 Agent',exact:true}).click();
  await page.getByLabel('Agent 名称').fill('保留草稿助手');
  await expect(page.getByRole('button',{name:'创建 Agent',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'配置runner',exact:true}).click();
  await expect(page.getByRole('heading',{name:'管理 Runner',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:/下载 macOS 安装包/})).toHaveAttribute('href','/downloads/MultiAgent-Scrum-Runner-macos-arm64.dmg');
  await expect(page.getByRole('button',{name:'刷新设备状态',exact:true})).toHaveCount(0);
  await expect(page.getByRole('navigation',{name:'工作台导航'}).getByRole('button',{name:'管理 Runner',exact:true})).toHaveAttribute('aria-current','page');
  await page.reload();
  await expect(page.getByRole('heading',{name:'管理 Runner',exact:true})).toBeVisible();
  await request.post('/__fixture/runner-ready');
  await page.getByRole('navigation',{name:'工作台导航'}).getByRole('button',{name:'我的 Agent',exact:true}).click();
  await expect(page.getByLabel('Agent 名称')).toHaveValue('保留草稿助手');
  await expect(page.getByLabel('Runner',{exact:true})).toHaveValue(id(41));
  await page.getByRole('button',{name:'创建 Agent',exact:true}).click();
  await expect(page.getByRole('button',{name:'查看 Agent：保留草稿助手',exact:true})).toBeVisible();
});

test('Runner management keeps device actions together and secondary settings collapsed',async({page})=>{
  await page.addInitScript(runnerId=>localStorage.setItem('mas.last-device.11111111-1111-4111-8111-111111111111',runnerId),id(41));
  await page.goto('/#devices');
  const device=page.getByRole('article',{name:'测试电脑',exact:true});
  await expect(device.getByText('在线',{exact:true})).toBeVisible();
  await expect(device.getByRole('button',{name:'读取本机会话'})).toBeVisible();
  await expect(device.getByRole('button',{name:'撤销设备绑定'})).toBeHidden();
  await expect(page.getByLabel('Runner ID',{exact:true})).toBeHidden();
  await device.getByText('设备详情与解绑',{exact:true}).click();
  await expect(device.getByText(/Runner ID：/)).toBeVisible();
  await expect(device.getByText(/这不代表本地进程已经停止/)).toBeVisible();
  await expect(device.getByRole('button',{name:'撤销设备绑定'})).toBeVisible();
  await device.getByText('设备详情与解绑',{exact:true}).click();
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:900});
    await page.reload();
    await expect(device.getByRole('button',{name:'读取本机会话'})).toBeVisible();
    await expect(page.getByRole('button',{name:'已连接',exact:true})).toBeDisabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`.impeccable/review/runner-${width}.png`});
  }
  await page.getByText('手动配对',{exact:true}).click();
  await page.getByLabel('Runner ID',{exact:true}).fill(id(41));
  await page.getByLabel('一次性配对码',{exact:true}).fill('invalid');
  await page.getByRole('button',{name:'绑定到我的账号',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'.impeccable/review/runner-mobile-pairing.png'});
  await page.getByRole('button',{name:'绑定到我的账号',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('16 位配对码');
});

test('Runner management distinguishes offline and revoked devices and recovers failed loading',async({page})=>{
  const identityId='11111111-1111-4111-8111-111111111111';
  let unavailable=false;
  await page.route('**/api/account/devices',route=>route.fulfill(unavailable?{status:503,json:{error:'Unavailable'}}:{json:{identityId,devices:[
    {runnerId:id(41),name:'离线电脑',online:false,lastSeen:1,revoked:false,executionReady:false},
    {runnerId:id(42),name:'已解绑电脑',online:false,lastSeen:1,revoked:true,executionReady:false},
  ]}}));
  await page.goto('/#devices');
  await expect(page.getByRole('article',{name:'离线电脑'})).toContainText('离线');
  const revoked=page.getByRole('article',{name:'已解绑电脑'});
  await expect(revoked).toContainText('已撤销');
  await expect(revoked.getByRole('button',{name:'读取本机会话'})).toHaveCount(0);
  unavailable=true;await page.reload();
  await expect(page.getByRole('alert')).toContainText('设备状态暂时无法确认');
  await expect(page.getByRole('article')).toHaveCount(0);
  unavailable=false;await page.getByRole('button',{name:'重新加载',exact:true}).click();
  await expect(page.getByRole('article',{name:'离线电脑'})).toBeVisible();
});

test('native session retry keeps request identity and a running turn retains its stop controls',async({page})=>{
  const runnerId=id(41),identityId='11111111-1111-4111-8111-111111111111',token='ab'.repeat(32),port=58001;
  let operationId=id(93);
  const sends:{requestId:string}[]=[];
  let cancelled=false,finished=false,truncated=false;
  await page.route('**/api/account/runner-local-config/**',route=>route.fulfill({status:200,contentType:'application/json',headers:{'X-MAS-Identity':identityId},body:JSON.stringify({identityId,runnerId,available:true,port,token})}));
  await page.route('http://127.0.0.1:'+port+'/**',async route=>{
    const request=route.request(),url=new URL(request.url());
    const headers={'Access-Control-Allow-Origin':'http://127.0.0.1:'+(process.env.MAS_ACCOUNT_UI_PORT??'5198'),'Access-Control-Allow-Headers':'Content-Type,X-MAS-Config-Token','Access-Control-Allow-Methods':'GET,POST,OPTIONS'};
    const respond=(body:object)=>route.fulfill({status:200,contentType:'application/json',headers,body:JSON.stringify(body)});
    if(request.method()==='OPTIONS')return respond({});
    if(url.pathname==='/challenge')return respond({runnerId,proof:createHmac('sha256',Buffer.from(token,'hex')).update(url.searchParams.get('nonce')!).digest('hex')});
    if(url.pathname==='/native-sessions'){
      const unavailable={installed:false,status:'unknown'},session={provider:'codex',cwd:'/tmp/fixture',updatedAt:1,state:'idle',canResume:true};
      return respond({ok:true,accounts:{codex:{installed:true,status:'ready'},claude:unavailable,codebuddy:unavailable,dsh:unavailable},projects:['/tmp/fixture'],sessions:[{...session,id:id(91),title:'First'},{...session,id:id(92),title:'Second'}]});
    }
    if(url.pathname.startsWith('/native-sessions/transcript/')){
      const parts=url.pathname.split('/');
      return respond({ok:true,provider:parts[3],id:parts[4],messages:[{role:'user',text:'之前的问题',timestamp:1},{role:'assistant',text:'之前的回答',timestamp:2}],hasMore:false,nextCursor:null});
    }
    if(url.pathname==='/native-sessions/send'){
      sends.push(request.postDataJSON());
      if(sends.length===1)return route.abort();
      cancelled=false;operationId=id(93+sends.length);
      return respond({ok:true,operationId});
    }
    if(url.pathname.endsWith('/cancel'))cancelled=true;
    return respond({ok:true,operationId,state:cancelled?'cancelled':finished?'done':'running',result:finished?'正在分析仓库结构…':'',startedAt:Date.now(),output:cancelled?'':(truncated?[{type:'assistant',message:{content:[{type:'thinking',thinking:'后续思考。'}]}}]:[{type:'system',subtype:'init',apiKeySource:'internal-provider',tools:['Read','Bash']},{type:'assistant',message:{content:[{type:'thinking',thinking:'先梳理目录结构，再定位会话入口。\n\n检查本机会话的输出格式。'},{type:'tool_use',name:'Read',input:{file_path:'/tmp/fixture/README.md'}},{type:'text',text:'正在分析仓库结构…'}]}}]).map(row=>JSON.stringify(row)).join('\n'),outputTruncated:truncated,thinking:truncated?'更早仍保留的思考。\n\n后续思考。':''});
  });
  await page.goto('/#devices');
  await page.getByRole('button',{name:'读取本机会话',exact:true}).click();
  // Orca-style inline split: no dialog; empty state until a session is picked.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('从左侧选择一个会话', {exact:false})).toBeVisible();
  await page.getByRole('option',{name:/Codex · First/}).click();
  const stream=page.getByRole('log');
  await expect(stream).toContainText('之前的问题');
  await expect(stream).toContainText('之前的回答');
  await page.getByRole('textbox',{name:'发送给本机会话'}).fill('Controlled fixture prompt');
  await page.getByRole('button',{name:'续接会话',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('本机会话未能续接');
  await page.getByRole('button',{name:'续接会话',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止本轮',exact:true})).toBeVisible();
  await expect(stream).toContainText('Controlled fixture prompt');
  await expect(stream).toContainText('正在分析仓库结构');
  await expect(stream.getByText('思考过程',{exact:true})).toBeVisible();
  await expect(stream).toContainText('先梳理目录结构');
  await expect(stream.locator('.native-chat-tool')).toContainText('Read');
  await expect(stream.locator('.native-chat-tool')).toContainText('/tmp/fixture/README.md');
  await expect(stream.locator('.native-chat-raw pre')).toBeHidden();
  await expect(stream.getByText('原始日志',{exact:true})).toBeVisible();
  await page.locator('.native-session-split').screenshot({path:'.impeccable/review/native-output-desktop.png'});
  await page.setViewportSize({width:390,height:900});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('.native-session-split').screenshot({path:'.impeccable/review/native-output-mobile.png'});
  await stream.getByText('原始日志',{exact:true}).click();
  await expect(stream.locator('.native-chat-raw pre')).toBeVisible();
  await stream.getByText('原始日志',{exact:true}).click();
  await page.setViewportSize({width:1440,height:1000});
  truncated=true;
  await expect(stream.locator('.native-chat-thinking')).toContainText('更早仍保留的思考。');
  truncated=false;
  expect(sends).toHaveLength(2);expect(sends[0].requestId).toBe(sends[1].requestId);
  await expect(page.getByRole('option',{name:/Codex · Second/})).toBeDisabled();
  await expect(page.getByLabel('项目目录',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'停止本轮',exact:true}).click();
  await expect(page.getByRole('option',{name:/Codex · Second/})).toBeEnabled();
  await page.getByRole('textbox',{name:'发送给本机会话'}).fill('Controlled fixture prompt');
  await page.getByRole('button',{name:'续接会话',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止本轮',exact:true})).toBeVisible();
  expect(sends).toHaveLength(3);expect(sends[2].requestId).not.toBe(sends[1].requestId);
  finished=true;
  await expect(stream.getByText('回复',{exact:true})).toBeVisible();
  await expect(stream.getByText('正在分析仓库结构…',{exact:true})).toHaveCount(1);
  await expect(stream.locator('.native-chat-output + .native-chat-message > strong')).toHaveText('回复');
  await expect(page.getByRole('button',{name:'停止本轮',exact:true})).toHaveCount(0);
  await expect(stream).toContainText('已停止');
});


test('agent row opens read-only details and edit icon saves the selected Agent',async({page,request})=>{
  await page.goto('/#agents');
  await expect(page.getByText('配置 Agent',{exact:true})).toHaveCount(0);
  const row=page.getByRole('button',{name:'查看 Agent：我的文档助手',exact:true});
  await row.click();
  const detail=page.getByRole('region',{name:'Agent 详情：我的文档助手',exact:true});
  await expect(detail.getByRole('combobox')).toHaveCount(0);
  await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  await detail.getByLabel('模型',{exact:true}).selectOption('deepseek-v4-pro');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(detail.getByLabel('模型',{exact:true})).toHaveValue('deepseek-v4-pro');
  await detail.getByLabel('最低难度').selectOption('2');
  await detail.getByLabel('最高难度').selectOption('4');
  await page.screenshot({path:'artifacts/account-navigation/desktop-agent-edit.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await detail.getByLabel('相对资源成本').scrollIntoViewIfNeeded();
  await expect(detail.getByRole('button',{name:'保存 Agent',exact:true})).toBeInViewport();
  await expect(detail.getByRole('button',{name:'关闭详情'})).toBeInViewport();
  await page.screenshot({path:'artifacts/account-navigation/mobile-agent-edit.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  let fail=true;
  await page.route('**/api/account/agent-settings',route=>fail?route.fulfill({status:503,contentType:'application/json',body:'{}'}):route.continue());
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(detail.getByLabel('模型',{exact:true})).toHaveValue('deepseek-v4-pro');
  fail=false;
  await detail.getByRole('button',{name:'关闭详情'}).click();
  await expect(page.getByRole('dialog',{name:'放弃未保存的修改？'})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(detail.getByRole('button',{name:'编辑 Agent',exact:true})).toBeVisible();
  await expect(detail.getByRole('combobox')).toHaveCount(0);
  await expect(row).toContainText('deepseek-v4-pro');
  await expect(detail).toContainText('2–4');
  const state=await (await request.get('/__fixture/state')).json();
  expect(state.requests.filter((r:{path:string;method:string})=>r.path==='/api/account/agent-settings'&&r.method==='POST').at(-1).body.agents).toHaveLength(1);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await detail.getByRole('button',{name:'关闭详情'}).click();
  await expect(row).toBeFocused();
});
