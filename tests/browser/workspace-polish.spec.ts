import {test,expect} from '@playwright/test';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const projectId=id(11),boardId=id(21);
const projectRoute=`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}`;

test.beforeEach(async({request})=>{await request.post('/__fixture/reset',{data:{mode:'multiple'}});});

test('partial project search does not claim no matches until every organization loads',async({page,request})=>{
 await request.post('/__fixture/reset',{data:{mode:'partial-error'}});
 await page.goto('/');
 await page.getByRole('searchbox',{name:'搜索项目'}).fill('不存在的项目');
 await expect(page.getByRole('alert')).toContainText('项目暂时无法加载');
 await expect(page.getByText('没有匹配的项目',{exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeVisible();
 await request.post('/__fixture/reset',{data:{mode:'multiple'}});
 await page.getByRole('button',{name:'重新加载',exact:true}).click();
 await expect(page.getByText('没有匹配的项目',{exact:true})).toBeVisible();
});

for(const scope of ['project','organization'] as const){
 test(`${scope} member counts wait for data and the narrow table scrolls with the keyboard`,async({page})=>{
  let release!:()=>void;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const path=scope==='project'?`/api/account/projects/${projectId}/members`:`/api/account/organizations/${id(1)}/members`;
  await page.route('**'+path,async route=>{await waiting;await route.continue();});
  await page.setViewportSize({width:390,height:844});
  await page.goto(scope==='project'?projectRoute+'/members':`/#/organizations/${id(1)}/members`);
  const heading=page.locator('.members-page .workspace-page-heading');
  await expect(heading).toContainText('正在读取成员…');
  await expect(heading).not.toContainText('0 位成员');
  release();
  await expect(heading).toContainText(scope==='project'?'1 位成员':'3 位成员');
  const table=page.getByRole('region',{name:scope==='project'?'项目成员列表':'组织成员列表',exact:true});
  await expect(table.getByRole('columnheader',{name:'成员',exact:true})).toHaveAttribute('scope','col');
  expect(await table.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);
  await table.focus();
  await expect(table).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect.poll(()=>table.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
}

test('task detail distinguishes unsynced assignments and prevents duplicate refreshes',async({page,request})=>{
 const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'核对责任信息与刷新状态'}})).json();
 let refreshing=false,refreshCalls=0,release!:()=>void;
 const waiting=new Promise<void>(resolve=>{release=resolve;});
 await page.route(`**/api/account/projects/${projectId}/boards/${boardId}/tasks/${taskId}`,async route=>{
  const refresh=refreshing;
  if(refresh){refreshCalls++;await waiting;}
  const response=await route.fetch(),body=await response.json();
  if(refresh)body.tasks[0].presentation={priority:'normal',dependencyCount:0,responsibleName:null,agentName:null,profile:null,recoveryRequired:false};
  await route.fulfill({response,json:body});
 });
 await page.goto(projectRoute+'/execution/tasks/'+taskId);
 await expect(page.getByRole('article',{name:'TASK-'+taskId.slice(0,6).toUpperCase(),exact:true})).toBeVisible();
 const properties=page.getByRole('complementary',{name:'任务属性'});
 await expect(properties.getByText('待同步',{exact:true})).toHaveCount(2);
 await expect(properties.getByText('未分配',{exact:true})).toHaveCount(0);
 const refresh=page.getByRole('button',{name:'刷新执行状态',exact:true});
 refreshing=true;
 await refresh.click();
 await expect.poll(()=>refreshCalls).toBe(1);
 await expect(refresh).toBeDisabled();
 await expect(refresh).toHaveAttribute('aria-busy','true');
 const box=(await refresh.boundingBox())!;
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await page.keyboard.press('Enter');
 release();
 await expect(refresh).toBeEnabled();
 await expect(properties.getByText('未分配',{exact:true})).toHaveCount(2);
 await expect(properties.getByText('待同步',{exact:true})).toHaveCount(0);
 expect(refreshCalls).toBe(1);
});
