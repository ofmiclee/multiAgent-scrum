import {test,expect,type Page,type Route} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const identityId='11111111-1111-4111-8111-111111111111',projectId=id(11),boardId=id(21),taskId=id(91),attemptId=id(92);
const taskUrl=(task=taskId)=>`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${task}`;
const originalIssue='Execution stopped; inspect permissions, account and prior attempt before retrying';
type Reason='owner_required'|'unsettled'|'not_failed'|'attempt_not_stopped'|'retry_limit'|'assessment_required'|null;
async function fixture(page:Page){
  const state={status:'failed',reason:null as Reason,canRetry:true,retryCount:0,readStatus:200,responseTaskId:taskId,posts:[] as Record<string,unknown>[],post:async(route:Route)=>{state.status='pending';state.canRetry=false;state.reason='not_failed';state.retryCount=1;await route.fulfill({json:{identityId,ok:true}});}};
  const task=(selected=taskId)=>({id:selected,boardId,title:'失败后人工重试',objective:'保留原任务内容并重新执行。',acceptanceCriteria:'成果通过人工验收。',requiredCapabilities:['coding'],status:state.status,
    assessment:{state:'done',calls:1,approved:true,result:{difficulty:3,risk:'medium',confidence:.9,rationale:'任务范围已确认',requiredCapability:'coding'},issues:[],attemptId:id(93)},
    execution:{state:state.status==='failed'?'failed':'queued',attemptId:state.status==='failed'?attemptId:null,summary:null,artifacts:[],issues:state.status==='failed'?[originalIssue]:[]},
    presentation:{priority:'normal',dependencyCount:0,responsibleName:'测试成员',agentName:'我的代码助手',profile:'codex-code',recoveryRequired:state.reason==='unsettled'},
  });
  await page.route('**/api/account/projects/'+projectId+'/boards/'+boardId+'/tasks/*',route=>route.fulfill({json:{identityId,projectId,tasks:[task(new URL(route.request().url()).pathname.split('/').at(-1))],hasMore:false,nextCursor:null}}));
  await page.route('**/tasks/*/retry',async route=>{
    if(route.request().method()==='POST'){state.posts.push(route.request().postDataJSON());return state.post(route);}
    return route.fulfill(state.readStatus===200?{json:{identityId,taskId:state.responseTaskId,revision:1,attemptId,retryCount:state.retryCount,retryLimit:3,canRetry:state.canRetry,reason:state.reason}}:{status:state.readStatus,json:{error:'Unavailable'}});
  });
  await page.route('**/tasks/*/activity',route=>route.fulfill({json:{identityId,projectId,taskId:new URL(route.request().url()).pathname.split('/').at(-2),items:state.retryCount?[{id:'retry:'+attemptId,type:'operation',timestamp:'2026-10-28T08:05:00.000Z',actorType:'member',actorId:identityId,displayName:'测试成员',agentId:null,ownerName:null,body:'人工重试执行',operation:'retry',inputRevision:1,attemptId,reviewStatus:null,fromState:'failed',toState:'pending'}]:[],hasMore:false,nextCursor:null}}));
  await page.route('**/tasks/*/conversation/messages',route=>route.fulfill({json:{identityId,projectId,taskId,taskStatus:'failed',attempt:{id:attemptId,state:'stopped',agentName:'我的代码助手',live:false,updatedAt:null,snapshot:null},messaging:{canSend:false,reason:'not_running',messages:[]}}}));
  await page.route('**/tasks/*/rework',route=>route.fulfill({json:{identityId,taskId:new URL(route.request().url()).pathname.split('/').at(-2),revision:1,canRework:true,unsettled:false,current:{title:task().title,objective:task().objective,acceptanceCriteria:task().acceptanceCriteria,requiredCapabilities:['coding']},history:[],attempts:[{id:attemptId,fence:1,state:'stopped',report:null,finishedAt:'2026-10-28T08:00:00.000Z',kind:'execute',decision:null,feedback:null}]}}));
  return state;
}
test.beforeEach(async({request})=>{await request.post('/__fixture/reset',{data:{mode:'multiple'}});});

test('task retry requires an explicit click and preserves input, assessment, drafts and history',async({page})=>{
  const consoleErrors:string[]=[];page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text());});
  const state=await fixture(page);await page.goto(taskUrl());
  const retry=page.getByRole('region',{name:'重试执行',exact:true});
  await expect(retry.getByRole('button',{name:'重试本次任务',exact:true})).toBeEnabled();
  await expect(retry).toContainText('保留当前输入版本和已批准评估');
  await expect(retry).toContainText('已重试 0 / 3 次');
  await expect(page.getByText(originalIssue,{exact:true})).toHaveCount(0);
  await expect(page.getByText(/旧记录未包含具体原因/)).toBeVisible();
  await page.getByRole('button',{name:'实时对话',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'实时对话'})).toBeVisible();
  await page.getByRole('dialog',{name:'实时对话'}).getByRole('button',{name:'关闭',exact:true}).click();
  await page.getByLabel('评论内容').fill('尚未提交的验收关注点');
  await page.getByRole('button',{name:'修订与历史',exact:true}).click();
  await page.getByLabel('修订任务标题').fill('保留本机修订草稿');
  expect(state.posts).toHaveLength(0);
  await retry.getByRole('button',{name:'重试本次任务',exact:true}).click();
  await expect(page.getByText('已评估，等待分配',{exact:true})).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0]).toEqual({identityId,requestId:expect.any(String),expectedRevision:1,expectedAttemptId:attemptId});
  expect(state.posts[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
  await expect(page.getByLabel('评论内容')).toHaveValue('尚未提交的验收关注点');
  await expect(page.getByLabel('修订任务标题')).toHaveValue('保留本机修订草稿');
  await expect(page.locator('.task-objective')).toHaveText('保留原任务内容并重新执行。');
  await page.getByText('执行尝试与验收反馈',{exact:true}).click();
  await expect(page.getByText('执行 · fence 1 · stopped',{exact:true})).toBeVisible();
  const activity=page.getByRole('region',{name:'任务动态'});
  await expect(activity.locator('.activity-operation-label')).toHaveText('人工重试');
  await activity.getByText('记录详情',{exact:true}).click();await expect(activity).toContainText('第 1 版');
  await expect(retry).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test('lost retry receipt survives reload and task navigation without auto replay',async({page})=>{
  const state=await fixture(page);
  state.post=async route=>{if(state.posts.length===1){state.status='pending';state.canRetry=false;state.reason='not_failed';state.retryCount=1;await route.abort('failed');}else await route.fulfill({json:{identityId,ok:true}});};
  await page.goto(taskUrl());await page.getByRole('button',{name:'重试本次任务',exact:true}).click();
  await expect(page.getByRole('region',{name:'重试执行'})).toContainText('重试结果尚未确认');
  await page.reload();
  await expect(page.getByRole('button',{name:'核对上次重试结果',exact:true})).toBeEnabled();
  expect(state.posts).toHaveLength(1);
  await page.goto(taskUrl(id(94)));await expect(page.getByRole('heading',{name:'任务详情',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'核对上次重试结果',exact:true})).toHaveCount(0);
  await page.goto(taskUrl());await page.getByRole('button',{name:'核对上次重试结果',exact:true}).click();
  await expect(page.getByRole('region',{name:'重试执行'})).toHaveCount(0);
  expect(state.posts).toHaveLength(2);expect(state.posts[1]).toEqual(state.posts[0]);
});

test('retry conflict rereads the server gate and never bypasses unsettled execution',async({page})=>{
  const state=await fixture(page);state.post=async route=>{state.canRetry=false;state.reason='unsettled';await route.fulfill({status:409,json:{error:'Conflict'}});};
  await page.goto(taskUrl());await page.getByRole('button',{name:'重试本次任务',exact:true}).click();
  const retry=page.getByRole('region',{name:'重试执行'});
  await expect(retry).toContainText('任务版本或执行状态已变化');
  await expect(retry).toContainText('旧执行尚未确认停止');
  await expect(retry.getByRole('button',{name:'重试本次任务',exact:true})).toHaveCount(0);
  await expect(retry.getByRole('button',{name:'核对上次重试结果',exact:true})).toHaveCount(0);
  await retry.getByRole('button',{name:'重新读取重试条件',exact:true}).click();
  await expect(retry).toContainText('旧执行尚未确认停止');expect(state.posts).toHaveLength(1);
});

test('retry gates, unavailable capability and mismatched task response never enable mutation',async({page})=>{
  const state=await fixture(page);state.canRetry=false;state.reason='owner_required';
  await page.goto(taskUrl());const retry=page.getByRole('region',{name:'重试执行'});
  for(const [reason,text] of [['owner_required','仅项目所有者'],['attempt_not_stopped','不符合直接重试条件'],['retry_limit','当前输入版本已重试 3 次'],['assessment_required','当前评估尚未通过']] as const){
    state.reason=reason;state.retryCount=reason==='retry_limit'?3:0;
    await page.getByRole('button',{name:'刷新执行状态',exact:true}).click();
    await expect(retry).toContainText(text);await expect(retry.getByRole('button',{name:'重试本次任务',exact:true})).toHaveCount(0);
  }
  state.readStatus=503;await page.getByRole('button',{name:'刷新执行状态',exact:true}).click();
  await expect(retry).toContainText('重试条件暂时无法确认');
  state.readStatus=200;state.canRetry=true;state.reason=null;state.responseTaskId=id(95);
  await retry.getByRole('button',{name:'重新读取重试条件',exact:true}).click();
  await expect(retry).toContainText('当前账号无权读取');await expect(retry.getByRole('button',{name:'重试本次任务',exact:true})).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
});

test('viewer cannot retry and duplicate clicks only submit one request',async({page,request})=>{
  const state=await fixture(page);await request.post('/__fixture/reset',{data:{mode:'viewer'}});
  await page.goto(taskUrl());await expect(page.getByRole('region',{name:'重试执行'})).toContainText('已重试 0 / 3 次');
  await expect(page.getByRole('button',{name:'重试本次任务',exact:true})).toHaveCount(0);expect(state.posts).toHaveLength(0);
  await request.post('/__fixture/reset',{data:{mode:'multiple'}});await page.reload();
  let finish:(()=>void)|undefined;const held=new Promise<void>(resolve=>{finish=resolve;});
  state.post=async route=>{await held;state.status='pending';await route.fulfill({json:{identityId,ok:true}});};
  const retry=page.getByRole('button',{name:'重试本次任务',exact:true});await expect(retry).toBeEnabled();
  await retry.evaluate(element=>{(element as HTMLButtonElement).click();(element as HTMLButtonElement).click();});
  await expect(page.getByRole('button',{name:'正在提交…',exact:true})).toBeDisabled();
  await expect.poll(()=>state.posts.length).toBe(1);finish!();
  await expect(page.getByRole('region',{name:'重试执行'})).toHaveCount(0);expect(state.posts).toHaveLength(1);
});

test('permission revoked during retry hides mutation and keeps the local comment draft',async({page})=>{
  const state=await fixture(page);state.post=route=>route.fulfill({status:403,json:{error:'Forbidden'}});
  await page.goto(taskUrl());await page.getByLabel('评论内容').fill('权限变化时保留的草稿');
  await page.getByRole('button',{name:'重试本次任务',exact:true}).click();
  const retry=page.getByRole('region',{name:'重试执行'});
  await expect(retry).toContainText('当前账号无权重试此任务');
  await expect(retry.getByRole('button',{name:'重试本次任务',exact:true})).toHaveCount(0);
  await expect(retry.getByRole('button',{name:'核对上次重试结果',exact:true})).toHaveCount(0);
  await expect(page.getByLabel('评论内容')).toHaveValue('权限变化时保留的草稿');expect(state.posts).toHaveLength(1);
});

test('stalled retry requests time out and reconcile the same request after recovery',async({page})=>{
  await page.clock.install({time:new Date('2026-10-28T08:00:00.000Z')});
  // Native AbortSignal uses a separate clock; simulate it with Playwright's controlled timers.
  await page.addInitScript(()=>{AbortSignal.timeout=milliseconds=>{const controller=new AbortController();window.setTimeout(()=>controller.abort(new DOMException('Timed out','TimeoutError')),milliseconds);return controller.signal;};});
  const state=await fixture(page),releases:(()=>void)[]=[];
  let holdRead=true,holdRefresh=false,refreshStarted=false;
  await page.route('**/tasks/'+taskId+'/retry',async route=>{
    if(route.request().method()==='GET'&&holdRead){await new Promise<void>(resolve=>releases.push(resolve));return route.fulfill({status:503,json:{error:'Unavailable'}}).catch(()=>{});}
    return route.fallback();
  });
  await page.route('**/boards/'+boardId+'/tasks/'+taskId,async route=>{
    if(holdRefresh){refreshStarted=true;await new Promise<void>(resolve=>releases.push(resolve));return route.fulfill({status:503,json:{error:'Unavailable'}}).catch(()=>{});}
    return route.fallback();
  });
  state.post=async route=>{
    state.status='pending';state.canRetry=false;state.reason='not_failed';state.retryCount=1;
    if(state.posts.length===1)await new Promise<void>(resolve=>releases.push(resolve));
    else holdRefresh=true;
    await route.fulfill({json:{identityId,ok:true}}).catch(()=>{});
  };
  try{
    await page.goto(taskUrl());const retry=page.getByRole('region',{name:'重试执行'});
    await expect.poll(()=>releases.length).toBeGreaterThan(0);await expect(retry).toContainText('正在确认重试条件');
    await page.clock.fastForward(10_000);
    await expect(retry).toContainText('重试条件暂时无法确认');
    await expect(retry.getByRole('button',{name:'重新读取重试条件',exact:true})).toBeEnabled();
    expect(state.posts).toHaveLength(0);holdRead=false;
    await retry.getByRole('button',{name:'重新读取重试条件',exact:true}).click();
    await retry.getByRole('button',{name:'重试本次任务',exact:true}).click();
    await expect.poll(()=>state.posts.length).toBe(1);await expect(retry.getByRole('button',{name:'正在提交…',exact:true})).toBeDisabled();
    await page.clock.fastForward(10_000);
    await expect(retry).toContainText('重试结果尚未确认');
    const confirm=retry.getByRole('button',{name:'核对上次重试结果',exact:true});await expect(confirm).toBeEnabled();
    expect(state.posts).toHaveLength(1);await confirm.click();
    await expect.poll(()=>refreshStarted).toBe(true);await page.clock.fastForward(10_000);
    await expect(retry).toContainText('重试已提交，但最新状态暂时无法读取');
    await expect(retry.getByRole('button',{name:'重新读取重试条件',exact:true})).toBeEnabled();
    await expect(retry.getByRole('button',{name:'核对上次重试结果',exact:true})).toHaveCount(0);
    holdRefresh=false;await page.getByRole('button',{name:'刷新执行状态',exact:true}).click();
    await expect(retry).toHaveCount(0);expect(state.posts).toHaveLength(2);expect(state.posts[1]).toEqual(state.posts[0]);
  }finally{releases.forEach(release=>release());}
});

test('retry visual review covers available and unsettled tasks on desktop and mobile',async({page})=>{
  test.skip(process.env.MAS_RETRY_REVIEW!=='1','Run explicitly for the bounded visual review.');
  const state=await fixture(page);await mkdir('.runtime/task-retry/review',{recursive:true});
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]] as const){
    await page.setViewportSize({width,height});
    for(const blocked of [false,true]){
      state.reason=blocked?'unsettled':null;state.canRetry=!blocked;
      await page.goto(taskUrl());const retry=page.getByRole('region',{name:'重试执行'});
      if(blocked){await expect(retry).toContainText('旧执行尚未确认停止');await expect(retry.getByRole('button',{name:'重试本次任务',exact:true})).toHaveCount(0);}
      else await expect(retry.getByRole('button',{name:'重试本次任务',exact:true})).toBeEnabled();
      await retry.scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:'.runtime/task-retry/review/'+name+'-'+(blocked?'unsettled':'ready')+'.png',animations:'disabled'});
    }
  }
  expect(state.posts).toHaveLength(0);
});
