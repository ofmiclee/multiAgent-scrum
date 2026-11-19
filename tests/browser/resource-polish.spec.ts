import {test,expect} from '@playwright/test';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const identityId='11111111-1111-4111-8111-111111111111';
test.beforeEach(async({request})=>{await request.post('/__fixture/reset',{data:{mode:'multiple'}});});

test('Agent model and account reads distinguish loading from failure and retry in place',async({page})=>{
  let release!:()=>void,ready=false;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  for(const path of ['agent-models','runner-credentials'])await page.route('**/api/account/'+path,async route=>{
    if(ready)return route.continue();
    await pending;return route.fulfill({status:503,json:{error:'Unavailable'}}).catch(()=>{});
  });
  await page.goto('/#agents');
  await page.getByRole('button',{name:'查看 Agent：我的文档助手',exact:true}).click();
  const detail=page.getByRole('region',{name:'Agent 详情：我的文档助手',exact:true});
  await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  await expect(detail.getByText('正在读取模型目录…',{exact:true})).toBeVisible();
  await expect(detail.getByLabel('模型',{exact:true})).toBeDisabled();
  await expect(detail.getByLabel('使用账号',{exact:true})).toBeEnabled();
  await expect(detail.getByLabel('使用账号',{exact:true}).locator('option:checked')).toHaveText('正在读取账号…');
  release();
  await expect(detail.getByRole('button',{name:'重新加载模型',exact:true})).toBeVisible();
  await expect(detail.getByRole('button',{name:'重新加载账号',exact:true})).toBeVisible();
  ready=true;
  await detail.getByRole('button',{name:'重新加载模型',exact:true}).click();
  await detail.getByRole('button',{name:'重新加载账号',exact:true}).click();
  await expect(detail.getByLabel('模型',{exact:true})).toBeEnabled();
  await expect(detail.getByLabel('模型',{exact:true}).locator('option[value="deepseek-v4-pro"]')).toHaveText('DeepSeek V4 Pro · 默认');
  await expect(detail.getByLabel('使用账号',{exact:true})).toHaveValue('legacy');
});

test('restored Agent creation validates the account during loading, failure and removed credentials',async({page,request})=>{
  await page.goto('/#agents');await page.getByRole('button',{name:'添加 Agent',exact:true}).click();
  await page.getByLabel('Agent 名称').fill('恢复草稿助手');
  const account=page.getByLabel('使用账号',{exact:true}),create=page.getByRole('button',{name:'创建 Agent',exact:true});
  await expect(account).toHaveValue('legacy');
  let phase:'pending'|'removed'|'ready'='pending',release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/account/runner-credentials',async route=>{
    if(phase==='ready')return route.continue();
    if(phase==='removed')return route.fulfill({headers:{'X-MAS-Identity':identityId},json:{identityId,credentials:[]}});
    await pending;return route.fulfill({status:503,json:{error:'Unavailable'}}).catch(()=>{});
  });
  await page.reload();await expect(page.getByLabel('Agent 名称')).toHaveValue('恢复草稿助手');
  await expect(page.getByLabel('Runner',{exact:true})).toHaveValue(id(41));
  await expect(account.locator('option:checked')).toHaveText('正在读取账号…');
  await create.click();await expect(account).toBeFocused();
  release();await expect(page.getByRole('button',{name:'重新加载账号',exact:true})).toBeVisible();
  await create.click();await expect(account).toBeFocused();
  phase='removed';await page.getByRole('button',{name:'重新加载账号',exact:true}).click();
  await expect(account.locator('option:checked')).toHaveText('暂无可用账号');
  await create.click();await expect(account).toBeFocused();
  let state=await(await request.get('/__fixture/state')).json();
  expect(state.requests.filter((r:{path:string;method:string})=>r.path==='/api/account/agents'&&r.method==='POST')).toHaveLength(0);
  phase='ready';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(account).toHaveValue('legacy');await create.click();
  await expect(page.getByRole('button',{name:'查看 Agent：恢复草稿助手',exact:true})).toBeVisible();
  state=await(await request.get('/__fixture/state')).json();
  expect(state.requests.filter((r:{path:string;method:string})=>r.path==='/api/account/agents'&&r.method==='POST')).toHaveLength(1);
});

test('an unverified changed account is blocked while stopping an existing Agent remains possible',async({page,request})=>{
  await page.goto('/#agents');await page.getByRole('button',{name:'查看 Agent：我的代码助手',exact:true}).click();
  const detail=page.getByRole('region',{name:'Agent 详情：我的代码助手',exact:true});
  await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  await detail.getByLabel('使用账号',{exact:true}).selectOption(id(91));
  await page.route('**/api/account/runner-credentials',route=>route.fulfill({status:503,json:{error:'Unavailable'}}));
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(detail.getByRole('button',{name:'重新加载账号',exact:true})).toBeVisible();
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(detail.getByLabel('使用账号',{exact:true})).toBeFocused();
  let state=await(await request.get('/__fixture/state')).json();
  expect(state.requests.filter((r:{path:string;method:string})=>r.path==='/api/account/agent-settings'&&r.method==='POST')).toHaveLength(0);
  await detail.getByRole('button',{name:'取消修改',exact:true}).click();
  await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  await detail.getByLabel('启用 Agent',{exact:true}).uncheck();
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(detail.getByRole('button',{name:'编辑 Agent',exact:true})).toBeVisible();
  state=await(await request.get('/__fixture/state')).json();
  expect(state.agents.find((agent:{id:string})=>agent.id===id(32)).enabled).toBe(false);
});

test('Runner changes and newer account reads cannot be overwritten by late responses',async({page})=>{
  const devices=[41,42].map(n=>({runnerId:id(n),name:n===41?'第一台电脑':'第二台电脑',online:true,lastSeen:Date.now(),revoked:false,executionReady:false}));
  await page.route('**/api/account/devices',route=>route.fulfill({json:{identityId,devices}}));
  let phase:'first'|'second'|'stale'|'latest'='first',held=0,release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/account/runner-credentials',async route=>{
    const current=phase,runnerId=current==='first'?id(41):id(42);
    const credentials=[{runnerId,id:id(91),profile:'dsh-text',kind:'api-key',label:current==='first'?'第一台账号':current==='stale'?'过期账号':current==='latest'?'最新账号':'第二台账号',ready:true}];
    if(current==='first'||current==='stale'){held++;await pending;}
    return route.fulfill({json:{identityId,credentials}}).catch(()=>{});
  });
  await page.goto('/#agents');
  await page.getByRole('button',{name:'添加 Agent',exact:true}).click();
  const runner=page.getByLabel('Runner',{exact:true}),account=page.getByLabel('使用账号',{exact:true});
  await runner.selectOption(id(41));
  await expect.poll(()=>held).toBeGreaterThan(0);
  phase='second';await runner.selectOption(id(42));
  await expect(account.locator('option:checked')).toHaveText('API Key · 第二台账号');
  const before=held;phase='stale';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>held).toBeGreaterThan(before);
  const aborted=page.waitForEvent('requestfailed',request=>request.url().endsWith('/runner-credentials'));
  phase='latest';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await aborted;
  await expect(account.locator('option:checked')).toHaveText('API Key · 最新账号');
  release();
  await expect(account.locator('option:checked')).toHaveText('API Key · 最新账号');
  await expect(runner).toHaveValue(id(42));
});

test('Agent save validates the required account before sending settings',async({page,request})=>{
  await page.goto('/#agents');
  await page.getByRole('button',{name:'查看 Agent：我的代码助手',exact:true}).click();
  const detail=page.getByRole('region',{name:'Agent 详情：我的代码助手',exact:true});
  await detail.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  const account=detail.getByLabel('使用账号',{exact:true});
  await expect(account.locator('option')).toHaveCount(3);
  await account.selectOption('');
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(account).toBeFocused();
  expect(await account.evaluate(node=>(node as HTMLSelectElement).validity.valueMissing)).toBe(true);
  let state=await(await request.get('/__fixture/state')).json();
  expect(state.requests.filter((r:{path:string;method:string})=>r.path==='/api/account/agent-settings'&&r.method==='POST')).toHaveLength(0);
  await account.selectOption(id(91));
  await detail.getByRole('button',{name:'保存 Agent',exact:true}).click();
  await expect(detail.getByRole('button',{name:'编辑 Agent',exact:true})).toBeVisible();
  state=await(await request.get('/__fixture/state')).json();
  expect(state.requests.filter((r:{path:string;method:string})=>r.path==='/api/account/agent-settings'&&r.method==='POST')).toHaveLength(1);
});

test('coordinator configuration retries failed reads and reports a pending save',async({page})=>{
  let failed=true,release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/account/projects/*/coordinator/agents',route=>failed?route.fulfill({status:503,json:{error:'Unavailable'}}):route.continue());
  await page.route('**/api/account/projects/*/coordinator',async route=>{
    if(route.request().method()==='POST')await pending;
    return route.continue();
  });
  await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'项目协调Agent',exact:true}).click();
  await expect(page.getByRole('button',{name:'重新加载协调配置',exact:true})).toBeVisible();
  failed=false;await page.getByRole('button',{name:'重新加载协调配置',exact:true}).click();
  await page.getByRole('radio',{name:/我的文档助手/}).check();
  await expect(page.getByText('协调配置暂时无法读取，请重试。',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'保存授权',exact:true}).click();
  await expect(page.getByRole('button',{name:'保存中…',exact:true})).toBeDisabled();
  release();await expect(page.getByRole('status')).toContainText('协调授权已保存');
});

test('coordinator retry preserves the unsubmitted Agent selection',async({page})=>{
  let failed=false;
  await page.route('**/api/account/projects/*/coordinator/agents',route=>failed?route.fulfill({status:503,json:{error:'Unavailable'}}):route.continue());
  await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
  await page.getByRole('button',{name:'项目协调Agent',exact:true}).click();
  await page.getByRole('radio',{name:/我的代码助手/}).check();
  failed=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button',{name:'重新加载协调配置',exact:true})).toBeVisible();
  failed=false;await page.getByRole('button',{name:'重新加载协调配置',exact:true}).click();
  await expect(page.getByRole('radio',{name:/我的代码助手/})).toBeChecked();
  await expect(page.getByRole('button',{name:'保存授权',exact:true})).toBeEnabled();
});

test('Runner failures stop presenting as loading and Agent touch controls remain reachable',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.route('**/api/account/devices',route=>route.fulfill({status:503,json:{error:'Unavailable'}}));
  await page.goto('/#agents');await page.getByRole('button',{name:'添加 Agent',exact:true}).click();
  await expect(page.getByLabel('Runner',{exact:true}).locator('option:checked')).toHaveText('Runner 列表读取失败');
  const close=page.getByRole('button',{name:'关闭新增 Agent',exact:true});
  const box=(await close.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(44);expect(box.height).toBeGreaterThanOrEqual(44);
  await close.click();await page.getByRole('button',{name:'查看 Agent：我的文档助手',exact:true}).click();
  await page.getByRole('button',{name:'编辑 Agent',exact:true}).click();
  expect((await page.locator('.agent-detail-enabled').boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
