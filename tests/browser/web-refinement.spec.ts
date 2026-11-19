import {test,expect} from '@playwright/test';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test.beforeEach(async({request})=>{await request.post('/__fixture/reset',{data:{mode:'multiple'}});});

test('project search preserves context, reports matches and keeps partial errors visible',async({page,request})=>{
 await page.goto('/');
 const search=page.getByRole('searchbox',{name:'搜索项目'});
 await search.fill('设计');
 await expect(page.getByText('匹配 1 / 2 个项目 · 2 个组织')).toBeVisible();
 await expect(page.getByRole('button',{name:'打开项目：协作工作台'})).toHaveCount(0);
 await page.getByRole('button',{name:'打开项目：设计系统'}).click();
 await page.getByRole('button',{name:'所有项目',exact:true}).click();
 await expect(search).toHaveValue('设计');
 await search.fill('不存在的项目');
 await expect(page.getByText('没有匹配的项目',{exact:true})).toHaveCount(1);
 await page.reload();await expect(search).toHaveValue('不存在的项目');
 await page.getByRole('button',{name:'清除搜索',exact:true}).click();
 await expect(page.getByRole('button',{name:/打开项目：/})).toHaveCount(2);
 await request.post('/__fixture/reset',{data:{mode:'partial-error'}});
 await page.reload();await search.fill('不存在');
 await expect(page.getByRole('alert')).toContainText('项目暂时无法加载');
 await expect(page.getByRole('button',{name:'重新加载',exact:true})).toBeVisible();
});

test('graphite workspace keeps mobile navigation compact and keyboard reachable',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 await expect(page.getByRole('heading',{name:'我的项目',exact:true})).toBeVisible();
 const sidebar=page.locator('.workspace-sidebar');
 expect((await sidebar.boundingBox())!.height).toBeLessThan(170);
 const nav=page.getByRole('navigation',{name:'工作台导航'});
 expect(await nav.evaluate(el=>el.scrollHeight<=el.clientHeight+2)).toBe(true);
 await nav.getByRole('button',{name:'管理 Runner',exact:true}).focus();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('heading',{name:'管理 Runner',exact:true})).toBeVisible();
 await page.goto('/');await page.getByRole('button',{name:'打开项目：协作工作台'}).click();
 await expect(page.getByRole('region',{name:'项目看板',exact:true})).toBeVisible();
 expect((await sidebar.boundingBox())!.height).toBeLessThan(170);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 const primary=page.getByRole('button',{name:'新建故事',exact:true}).first();
 await expect(primary).toHaveCSS('background-color','rgb(41, 46, 56)');
 expect((await page.getByRole('button',{name:'个人资料',exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('user menu opens with Enter, Space and ArrowDown and restores focus on Escape',async({page})=>{
 await page.goto('/');
 const trigger=page.getByRole('button',{name:'用户菜单',exact:true});
 const menu=page.getByRole('menu',{name:'用户菜单',exact:true});
 for(const key of ['Enter','Space','ArrowDown']){
  await trigger.focus();await page.keyboard.press(key);
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded','true');
  await expect(menu.getByRole('menuitem',{name:'组织管理',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded','false');
  await expect(trigger).toBeFocused();
 }
});

test('user menu supports arrow and boundary keys and restores focus after Tab or Shift+Tab',async({page})=>{
 await page.goto('/');
 const trigger=page.getByRole('button',{name:'用户菜单',exact:true});
 const menu=page.getByRole('menu',{name:'用户菜单',exact:true});
 const organizations=menu.getByRole('menuitem',{name:'组织管理',exact:true});
 const signOut=menu.getByRole('menuitem',{name:'退出系统',exact:true});
 await trigger.focus();await page.keyboard.press('Enter');
 await expect(organizations).toBeFocused();
 await page.keyboard.press('ArrowDown');await expect(signOut).toBeFocused();
 await page.keyboard.press('ArrowUp');await expect(organizations).toBeFocused();
 await page.keyboard.press('End');await expect(signOut).toBeFocused();
 await page.keyboard.press('Home');await expect(organizations).toBeFocused();
 await page.keyboard.press('Tab');
 await expect(menu).toBeHidden();
 await expect(trigger).toHaveAttribute('aria-expanded','false');
 await expect(trigger).toBeFocused();
 await page.keyboard.press('Enter');await expect(organizations).toBeFocused();
 await page.keyboard.press('Shift+Tab');
 await expect(menu).toBeHidden();
 await expect(trigger).toHaveAttribute('aria-expanded','false');
 await expect(trigger).toBeFocused();
});

test.describe('touch user menu',()=>{
 test.use({hasTouch:true,viewport:{width:390,height:844}});
 test('stays within the narrow viewport and opens organization management',async({page})=>{
  await page.goto('/');
  const trigger=page.getByRole('button',{name:'用户菜单',exact:true});
  const menu=page.getByRole('menu',{name:'用户菜单',exact:true});
  await trigger.tap();await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS('background-color','rgb(255, 255, 255)');
  await expect(menu).toHaveCSS('border-radius','8px');
  await expect(menu.getByRole('menuitem',{name:'组织管理',exact:true})).toHaveCSS('color','rgb(34, 38, 46)');
  const box=(await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(390);expect(box.y+box.height).toBeLessThanOrEqual(844);
  for(const item of await menu.getByRole('menuitem').all())expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const triggerBox=(await trigger.boundingBox())!;
  await page.touchscreen.tap(triggerBox.x+triggerBox.width/2,triggerBox.y+triggerBox.height/2);await expect(menu).toBeHidden();
  await trigger.tap();await expect(menu).toBeVisible();
  const headingBox=(await page.getByRole('heading',{name:'我的项目',exact:true}).boundingBox())!;
  await page.touchscreen.tap(headingBox.x+headingBox.width/2,headingBox.y+headingBox.height/2);await expect(menu).toBeHidden();
  await trigger.tap();
  await menu.getByRole('menuitem',{name:'组织管理',exact:true}).tap();
  await expect(page.getByRole('heading',{name:'组织管理',exact:true})).toBeVisible();
  await expect(menu).toBeHidden();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
});

test('profile loading can recover in place and mobile sign-in leads with the form',async({page,request})=>{
 let failed=true;
 await page.route('**/api/account/profile',route=>failed?route.fulfill({status:503,json:{error:'offline'}}):route.continue());
 await page.goto('/');await page.getByRole('button',{name:'个人资料',exact:true}).click();
 await expect(page.getByRole('button',{name:'重新加载资料',exact:true})).toBeVisible();
 failed=false;await page.getByRole('button',{name:'重新加载资料',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'昵称',exact:true})).toHaveValue('测试成员');
 await request.post('/__fixture/reset',{data:{mode:'signed-out'}});
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 const title=page.getByRole('heading',{name:'登录工作空间',exact:true});
 await expect(title).toBeVisible();expect((await title.boundingBox())!.y).toBeLessThan(180);
 await expect(page.getByRole('button',{name:/GitHub/})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('conversation keeps the composer visible in a short viewport while the transcript scrolls',async({page,request})=>{
 const projectId=id(11),boardId=id(21),identityId='11111111-1111-4111-8111-111111111111';
 const {taskId}=await(await request.post(`/api/account/projects/${projectId}/boards/${boardId}/tasks`,{data:{requestId:id(91),body:'检查短屏幕实时对话'}})).json();
 await page.route(`**/tasks/${taskId}/conversation/messages`,route=>route.fulfill({json:{identityId,projectId,taskId,taskStatus:'running',messaging:{canSend:true,reason:null,messages:[]},attempt:{id:id(92),state:'running',agentName:'代码助手',live:true,updatedAt:'2026-10-28T08:00:00.000Z',snapshot:{revision:1,truncated:false,entries:Array.from({length:24},(_,i)=>({id:'message-'+i,kind:'message',text:'执行进度 '+i+'：正在核对相关实现和验收条件。',state:'completed',at:i}))}}}}));
 await page.setViewportSize({width:390,height:560});
 await page.goto(`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/execution/tasks/${taskId}`);
 await page.getByRole('button',{name:'实时对话',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'实时对话'}),input=dialog.getByRole('textbox',{name:'给 Agent 发消息'}),send=dialog.getByRole('button',{name:'发送',exact:true});
 await expect(input).toBeEnabled();await input.fill('请补充验证结果');
 const box=(await send.boundingBox())!;expect(box.y+box.height).toBeLessThanOrEqual(548);
 expect((await input.boundingBox())!.y).toBeGreaterThan(80);
 const stream=dialog.getByRole('log');expect(await stream.evaluate(el=>el.scrollHeight>el.clientHeight)).toBe(true);
 expect(await dialog.locator('.app-modal-body').evaluate(el=>el.scrollHeight<=el.clientHeight+2)).toBe(true);
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await expect(page.getByRole('button',{name:'实时对话',exact:true})).toBeFocused();
});
