import {test,expect,type Page} from '@playwright/test';

test.beforeEach(async({request})=>{await request.post('/__fixture/reset',{data:{mode:'multiple'}});});

async function openSettings(page:Page,projectName='协作工作台'){
  await page.goto('/');
  await page.getByRole('button',{name:'打开项目：'+projectName}).click();
  await page.getByRole('button',{name:'项目设置',exact:true}).click();
}

test('management settings tabs follow keyboard direction and retain focus',async({page})=>{
  await openSettings(page);
  const base=page.getByRole('tab',{name:'基础信息',exact:true}),config=page.getByRole('tab',{name:'项目配置',exact:true}),personal=page.getByRole('tab',{name:'我的配置',exact:true});
  await base.focus();await base.press('ArrowLeft');
  await expect(personal).toBeFocused();await expect(personal).toHaveAttribute('aria-selected','true');
  await personal.press('ArrowLeft');await expect(config).toBeFocused();
  await config.press('ArrowRight');await expect(personal).toBeFocused();
  await personal.press('Home');await expect(base).toBeFocused();
  await base.press('End');await expect(personal).toBeFocused();
});

test('management settings preserve both configuration drafts across tabs without persisting secrets',async({page})=>{
  await openSettings(page);
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  const config=page.getByRole('region',{name:'项目配置',exact:true});
  await config.getByRole('button',{name:'编辑配置',exact:true}).click();
  await config.getByLabel('分支',{exact:true}).fill('draft-branch');
  await config.getByLabel('.deploy-access.env',{exact:true}).fill('PRIVATE_TOKEN=keep-only-in-memory\n');
  await page.getByRole('tab',{name:'我的配置',exact:true}).click();
  const personal=page.getByRole('region',{name:'我的配置',exact:true});
  await personal.getByLabel('本机工作目录',{exact:true}).fill('/Users/test/draft');
  await personal.getByLabel('Git 用户名',{exact:true}).fill('draft-user');
  await personal.getByLabel('Git 令牌',{exact:true}).fill('personal-memory-token');
  await page.getByRole('tab',{name:'基础信息',exact:true}).click();
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  await expect(config.getByLabel('分支',{exact:true})).toHaveValue('draft-branch');
  await expect(config.getByLabel('.deploy-access.env',{exact:true})).toHaveValue('PRIVATE_TOKEN=keep-only-in-memory\n');
  await page.getByRole('tab',{name:'我的配置',exact:true}).click();
  await expect(personal.getByLabel('本机工作目录',{exact:true})).toHaveValue('/Users/test/draft');
  await expect(personal.getByLabel('Git 用户名',{exact:true})).toHaveValue('draft-user');
  await expect(personal.getByLabel('Git 令牌',{exact:true})).toHaveValue('personal-memory-token');
  await personal.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await personal.getByRole('button',{name:'编辑配置',exact:true}).click();
  await personal.getByLabel('本机工作目录',{exact:true}).fill('/Users/test/edited-draft');
  await personal.getByLabel('Git 令牌',{exact:true}).fill('replacement-memory-token');
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  await page.getByRole('tab',{name:'我的配置',exact:true}).click();
  await expect(personal.getByLabel('本机工作目录',{exact:true})).toHaveValue('/Users/test/edited-draft');
  await expect(personal.getByLabel('Git 令牌',{exact:true})).toHaveValue('replacement-memory-token');
  const stored=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));
  expect(stored).not.toContain('keep-only-in-memory');expect(stored).not.toContain('personal-memory-token');expect(stored).not.toContain('replacement-memory-token');
});

test('management settings retry a failed configuration read in place',async({page})=>{
  let fail=true;
  await page.route('**/api/account/projects/*/files',route=>fail?route.fulfill({status:503,json:{error:'Unavailable'}}):route.continue());
  await openSettings(page);await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('项目配置暂时无法读取');
  fail=false;await page.getByRole('button',{name:'重新加载配置',exact:true}).click();
  await expect(page.getByRole('region',{name:'项目配置',exact:true}).getByRole('button',{name:'编辑配置',exact:true})).toBeVisible();
});

test('management settings retry a failed editor without reloading the page',async({page})=>{
  let fail=true;
  await page.route('**/api/account/projects/*/files/editor',route=>fail?route.fulfill({status:503,json:{error:'Unavailable'}}):route.continue());
  await openSettings(page);await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  const config=page.getByRole('region',{name:'项目配置',exact:true});
  await expect(config.getByRole('alert')).toContainText('项目文件暂时无法读取');
  fail=false;await config.getByRole('button',{name:'重新加载编辑器',exact:true}).click();
  await expect(config.getByRole('button',{name:'编辑配置',exact:true})).toBeVisible();
});

test('management settings only load shared editor for authorized owners',async({page})=>{
  let editorReads=0;
  await page.route('**/api/account/projects/*/files/editor',route=>{editorReads++;return route.continue();});
  await openSettings(page,'设计系统');await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  await expect(page.getByRole('region',{name:'项目配置',exact:true}).getByText('公开摘要',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'我的配置',exact:true}).click();
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  expect(editorReads).toBe(0);
  await expect(page.getByRole('button',{name:'编辑配置',exact:true})).toHaveCount(0);
});

test('management settings retain the original personal draft version after a concurrent update',async({page,request})=>{
  const path='/api/account/projects/00000000-0000-4000-8000-000000000011/files/personal';
  const saved={runnerId:'00000000-0000-4000-8000-000000000041',directory:'/Users/test/original',gitUsername:'test',deploymentAccess:false,expectedVersion:0};
  await request.post(path,{data:saved});
  await openSettings(page);await page.getByRole('tab',{name:'我的配置',exact:true}).click();
  const personal=page.getByRole('region',{name:'我的配置',exact:true});
  await personal.getByRole('button',{name:'编辑配置',exact:true}).click();
  await personal.getByLabel('本机工作目录',{exact:true}).fill('/Users/test/my-draft');
  await request.post(path,{data:{...saved,directory:'/Users/test/other-editor',expectedVersion:1}});
  await page.getByRole('tab',{name:'基础信息',exact:true}).click();
  const refreshed=page.waitForResponse(response=>response.url().endsWith('/files')&&response.request().method()==='GET');
  await page.getByRole('tab',{name:'我的配置',exact:true}).click();await refreshed;
  let submittedVersion:number|undefined;
  await page.route('**/files/personal',route=>{submittedVersion=route.request().postDataJSON().expectedVersion;return route.fulfill({status:409,json:{error:'Conflict'}});});
  await personal.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await expect(personal.getByRole('status')).toContainText('配置版本已变化');
  expect(submittedVersion).toBe(1);
  await expect(personal.getByLabel('本机工作目录',{exact:true})).toHaveValue('/Users/test/my-draft');
});

test('management settings keep the selected Runner while a background refresh is pending',async({page,request})=>{
  const runnerA='00000000-0000-4000-8000-000000000041',runnerB='00000000-0000-4000-8000-000000000042';
  await request.post('/api/account/projects/00000000-0000-4000-8000-000000000011/files/personal',{data:{runnerId:runnerA,directory:'/Users/test/original',gitUsername:'test',deploymentAccess:false,expectedVersion:0}});
  await page.route('**/api/account/devices',route=>route.fulfill({json:{identityId:'11111111-1111-4111-8111-111111111111',devices:[runnerA,runnerB].map((runnerId,index)=>({runnerId,name:'电脑 '+(index+1),online:true,revoked:false,lastSeen:1,executionReady:true}))}}));
  await openSettings(page);await page.getByRole('tab',{name:'我的配置',exact:true}).click();
  const personal=page.getByRole('region',{name:'我的配置',exact:true});
  await personal.getByRole('button',{name:'编辑配置',exact:true}).click();
  await page.getByRole('tab',{name:'基础信息',exact:true}).click();
  let release!:()=>void,arrived!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{arrived=resolve;});
  await page.route('**/api/account/projects/*/files',async route=>{arrived();await pending;await route.continue();});
  await page.getByRole('tab',{name:'我的配置',exact:true}).click();await started;
  await personal.getByLabel('Runner',{exact:true}).selectOption(runnerB);
  await personal.getByLabel('本机工作目录',{exact:true}).fill('/Users/test/new-runner');
  await personal.getByLabel('Git 用户名',{exact:true}).fill('new-user');
  await personal.getByLabel('Git 令牌',{exact:true}).fill('new-runner-memory-token');
  const response=page.waitForResponse(value=>value.url().endsWith('/files'));release();await response;
  await expect(personal.getByLabel('Runner',{exact:true})).toHaveValue(runnerB);
  await expect(personal.getByLabel('本机工作目录',{exact:true})).toHaveValue('/Users/test/new-runner');
  await expect(personal.getByLabel('Git 用户名',{exact:true})).toHaveValue('new-user');
  await expect(personal.getByLabel('Git 令牌',{exact:true})).toHaveValue('new-runner-memory-token');
});

test('management settings clear sensitive drafts after access is revoked',async({page})=>{
  let revoked=false;
  await page.route('**/api/account/projects/*/files',route=>revoked?route.fulfill({status:403,json:{error:'Forbidden'}}):route.continue());
  await openSettings(page);await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  const config=page.getByRole('region',{name:'项目配置',exact:true});
  await config.getByRole('button',{name:'编辑配置',exact:true}).click();
  await config.getByLabel('.deploy-access.env',{exact:true}).fill('PRIVATE_TOKEN=revoked-draft\n');
  await page.getByRole('tab',{name:'基础信息',exact:true}).click();revoked=true;
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  await expect(config.getByRole('alert')).toContainText('访问已失效');
  await expect(config.getByRole('button',{name:'保存修改',exact:true})).toHaveCount(0);
  await expect(config.locator('textarea')).toHaveCount(0);
  revoked=false;await config.getByRole('button',{name:'重新加载配置',exact:true}).click();
  await config.getByRole('button',{name:'编辑配置',exact:true}).click();
  await expect(config.getByLabel('.deploy-access.env',{exact:true})).not.toHaveValue(/revoked-draft/);
});

test('management settings clear shared drafts when owner editing permission is removed',async({page})=>{
  let canEdit=true;
  await page.route('**/api/account/projects/*/files',async route=>{const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),canEdit}});});
  await openSettings(page);await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  const config=page.getByRole('region',{name:'项目配置',exact:true});
  await config.getByRole('button',{name:'编辑配置',exact:true}).click();
  await config.getByLabel('.deploy-access.env',{exact:true}).fill('PRIVATE_TOKEN=previous-owner-draft\n');
  await page.getByRole('tab',{name:'基础信息',exact:true}).click();canEdit=false;
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  await expect(config.getByText('公开摘要',{exact:true})).toBeVisible();
  await expect(config.locator('textarea')).toHaveCount(0);
  await expect(config.getByRole('button',{name:'编辑配置',exact:true})).toHaveCount(0);
  await page.getByRole('tab',{name:'基础信息',exact:true}).click();canEdit=true;
  await page.getByRole('tab',{name:'项目配置',exact:true}).click();
  await config.getByRole('button',{name:'编辑配置',exact:true}).click();
  await expect(config.getByLabel('.deploy-access.env',{exact:true})).not.toHaveValue(/previous-owner-draft/);
});

for(const status of [403,404])for(const verificationStatus of [200,503])test(`management settings preserve personal drafts after operation ${status} and access check ${verificationStatus}`,async({page,request})=>{
  const path='/api/account/projects/00000000-0000-4000-8000-000000000011/files/personal';
  const saved={runnerId:'00000000-0000-4000-8000-000000000041',directory:'/Users/test/original',gitUsername:'test',deploymentAccess:false,expectedVersion:0};
  await request.post(path,{data:saved});
  await openSettings(page);await page.getByRole('tab',{name:'我的配置',exact:true}).click();
  const personal=page.getByRole('region',{name:'我的配置',exact:true});
  await personal.getByRole('button',{name:'编辑配置',exact:true}).click();
  await personal.getByLabel('本机工作目录',{exact:true}).fill('/Users/test/retained-draft');
  await personal.getByLabel('Git 令牌',{exact:true}).fill('operation-failed-memory-token');
  await request.post(path,{data:{...saved,directory:'/Users/test/concurrent',expectedVersion:1}});
  let checks=0;
  await page.route('**/api/account/projects/*/files',route=>{checks++;return verificationStatus===200?route.continue():route.fulfill({status:verificationStatus,json:{error:'Unavailable'}});});
  const submitted:number[]=[];
  await page.route('**/files/personal',route=>{submitted.push(route.request().postDataJSON().expectedVersion);return route.fulfill({status,json:{error:'Operation denied'}});});
  await personal.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await expect(personal.getByRole('status')).toContainText('我的配置保存失败');
  await expect(personal.getByLabel('本机工作目录',{exact:true})).toHaveValue('/Users/test/retained-draft');
  await expect(personal.getByLabel('Git 令牌',{exact:true})).toHaveValue('operation-failed-memory-token');
  expect(checks).toBe(1);
  await personal.getByRole('button',{name:'保存我的配置',exact:true}).click();
  await expect.poll(()=>submitted.length).toBe(2);expect(submitted).toEqual([1,1]);
});
