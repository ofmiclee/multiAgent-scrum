import {test,expect} from '@playwright/test';

test.beforeEach(async({request})=>{await request.post('/__fixture/reset',{data:{mode:'multiple'}});});

test('workspace provides a keyboard shortcut past navigation',async({page})=>{
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'我的项目',exact:true})).toBeVisible();
  await page.keyboard.press('Tab');
  const skip=page.getByRole('button',{name:'跳至主要内容',exact:true});
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region',{name:'工作台',exact:true})).toBeFocused();
});

test('help explanations follow keyboard focus and close on Escape',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'管理 Runner',exact:true}).click();
  const help=page.getByRole('button',{name:'连接电脑说明',exact:true});
  await help.focus();
  await expect(page.getByRole('tooltip')).toContainText('浏览器不能判断');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toBeHidden();
  await expect(help).toBeFocused();
});

test.describe('touch explanations',()=>{
  test.use({hasTouch:true,viewport:{width:390,height:844}});
  test('toggle on repeat tap and stay within the viewport',async({page})=>{
    await page.goto('/');
    await page.getByRole('button',{name:'管理 Runner',exact:true}).tap();
    const help=page.getByRole('button',{name:'连接电脑说明',exact:true});
    await help.tap();await expect(page.getByRole('tooltip')).toBeVisible();
    const content=page.locator('.help-tip'),box=(await content.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(844);
    await help.tap();await expect(page.getByRole('tooltip')).toBeHidden();
  });
});

test('sign-in fields retain a visible keyboard focus outline',async({page,request})=>{
  await request.post('/__fixture/reset',{data:{mode:'signed-out'}});
  await page.goto('/');
  const email=page.getByRole('textbox',{name:'邮箱',exact:true});
  await email.focus();
  await expect(email).toHaveCSS('outline-style','solid');
  await expect(email).toHaveCSS('outline-width','2px');
});

test('hidden avatar input does not widen the organization page on desktop or mobile',async({page})=>{
  await page.goto('/#/organizations/00000000-0000-4000-8000-000000000001/info');
  const avatar=page.locator('.organization-avatar-editor');
  await expect(avatar).toBeVisible();
  for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
    await page.setViewportSize(viewport);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(avatar.locator('input[type="file"]')).toHaveCSS('width','1px');
  }
});
