import {test,expect} from '@playwright/test';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const projectId=id(11),boardId=id(21),projectPath='/api/account/projects/'+projectId;
const boardUrl=`/#/organizations/${id(1)}/projects/${projectId}/boards/${boardId}/board`;
test.beforeEach(async({request})=>{await request.post('/__fixture/reset',{data:{mode:'multiple'}});});

test('story cards open the selected story without splitting or losing another story draft',async({page,request})=>{
 for(const [index,title] of ['第一个需求','第二个需求'].entries()){
  const response=await request.post(projectPath+'/boards/'+boardId+'/stories',{data:{requestId:id(91+index),title,body:title+'正文'}});expect(response.ok()).toBe(true);
 }
 await page.goto(boardUrl);
 const stories=page.getByRole('region',{name:'故事池列',exact:true});
 await stories.getByRole('button',{name:/第二个需求/}).click();
 let editor=page.getByRole('region',{name:'编辑故事',exact:true});
 await expect(editor.getByLabel('故事标题')).toHaveValue('第二个需求');
 await expect(page.getByRole('region',{name:'任务拆分与发布'})).toHaveCount(0);
 await editor.getByLabel('故事标题').fill('第二个需求的未保存草稿');
 await page.getByRole('button',{name:'项目 Scrum 看板',exact:true}).click();
 await stories.getByRole('button',{name:/第一个需求/}).click();
 editor=page.getByRole('region',{name:'编辑故事',exact:true});
 await expect(editor.getByLabel('故事标题')).toHaveValue('第一个需求');
 await page.getByRole('button',{name:'项目 Scrum 看板',exact:true}).click();
 await stories.getByRole('button',{name:/第二个需求/}).click();
 await expect(page.getByRole('region',{name:'编辑故事',exact:true}).getByLabel('故事标题')).toHaveValue('第二个需求的未保存草稿');
 const state=await(await request.get('/__fixture/state')).json();
 expect(state.requests.filter((item:{path:string;method:string})=>item.method==='POST'&&/\/(assistance|publications)$/.test(item.path))).toHaveLength(0);
});

test('confirmed publication links open the exact published task in its board',async({page,request})=>{
 const {story}=await(await request.post(projectPath+'/boards/'+boardId+'/stories',{data:{requestId:id(91),title:'发布后继续查看任务',body:'将发布结果连接到对应任务。'}})).json();
 const objective='完成发布结果到任务详情的连接';
 const {taskId}=await(await request.post(projectPath+'/boards/'+boardId+'/tasks',{data:{requestId:id(92),body:objective}})).json();
 const task={key:'delivery',title:'交付任务入口',objective,acceptanceCriteria:'发布后可以打开对应任务。',requiredCapabilities:['coding'],priority:'normal',dependsOn:[]};
 let publications=0;
 await page.route('**/stories/'+story.id+'/assistance',route=>route.fulfill({json:{jobs:[{id:id(93),storyVersion:1,state:'draft',version:2,calls:1,stale:false,issues:[],proposal:{tasks:[task]}}]}}));
 await page.route('**/stories/'+story.id+'/publications',route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{publications:[],hasMore:false}});
  publications++;const input=route.request().postDataJSON();expect(input.tasks).toEqual([task]);
  return route.fulfill({json:{publication:{id:id(94),projectId,boardId,storyId:story.id,storyVersion:1,authorId:id(1),sourceStory:{title:story.title,body:story.body,version:1},tasks:[{...task,id:taskId,status:'pending'}]}}});
 });
 await page.goto(boardUrl);
 await page.getByRole('region',{name:'故事池列',exact:true}).getByRole('button',{name:/发布后继续查看任务/}).click();
 await page.getByRole('button',{name:'拆分任务',exact:true}).click();
 await expect(page.locator('.publication-task > summary')).toHaveCount(1);
 await page.getByRole('button',{name:'完成拆分',exact:true}).click();
 const publish=page.getByRole('button',{name:'确认发布任务',exact:true});
 await expect(publish).toBeDisabled();
 await page.getByLabel('我已确认故事版本和任务拆分',{exact:false}).check();await publish.click();
 const result=page.getByRole('region',{name:'发布结果',exact:true});
 await expect(result).toContainText('已发布 1 项任务');
 await result.getByRole('button',{name:'查看任务：交付任务入口',exact:true}).click();
 await expect(page).toHaveURL(new RegExp('/execution/tasks/'+taskId+'$'));
 await expect(page.getByRole('heading',{name:'任务详情',level:1,exact:true})).toBeVisible();
 await expect(page.getByRole('heading',{name:'任务详情',level:1,exact:true})).toBeFocused();
 expect((await page.getByRole('heading',{name:'任务详情',level:1,exact:true}).boundingBox())!.y).toBeLessThan(100);
 await expect(page.locator('.task-detail-content .task-objective')).toHaveText(objective);
 expect(publications).toBe(1);
});
