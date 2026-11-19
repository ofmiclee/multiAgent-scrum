import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowRight,BookOpen,ChevronRight,Circle,CircleCheck,CircleDashed,Clock3,Columns3,FolderKanban,LoaderCircle,Plus,RefreshCw,Search,Settings2,ShieldCheck,XCircle,Zap} from 'lucide-react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {taskList} from './Execution';
import {taskStatusLabel} from './task-status';
import {TaskAttention,TaskPeople} from './TaskPresentation';
import CreateWorkDialog from './CreateWorkDialog';
import BodyContent from './BodyContent';

const storiesSchema=z.object({stories:z.array(z.object({id:z.uuid(),projectId:z.uuid(),boardId:z.uuid(),title:z.string(),body:z.string(),version:z.number(),authorId:z.uuid(),number:z.number().int().nullable(),reference:z.string().nullable()}).strict())}).strict();
type Props={identityId:string;project:{id:string;name:string;role?:string};board:{id:string;name:string};pages:string[];setPages:(pages:string[])=>void;onStories:(mode?:'list'|'create',storyId?:string)=>void;onExecution:(taskId:string)=>void;onBack:()=>void};

export default function ProjectBoard({identityId,project,board,pages,setPages,onStories,onExecution,onBack}:Props){
  const [data,setData]=useState<z.infer<typeof taskList>|null>(null),[stories,setStories]=useState<z.infer<typeof storiesSchema>['stories']|null>(null);
  const [revision,setRevision]=useState(0),[notice,setNotice]=useState('');
  const [creating,setCreating]=useState<'story'|'task'|null>(null);
  const [search,setSearch]=useState(''),[filter,setFilter]=useState('all');
  const loadGeneration=useRef(0),hasSnapshot=useRef(false);
  const cursor=pages.at(-1);
  const load=useCallback(async(signal:AbortSignal)=>{
    const generation=++loadGeneration.current;
    try{
      const [tasks,requirements]=await Promise.all([
        accountRequest('/projects/'+project.id+'/tasks'+(cursor?'/before/'+cursor:''),taskList,{signal,taskPresentation:true}),
        accountRequest('/projects/'+project.id+'/boards/'+board.id+'/stories',storiesSchema,{signal}),
      ]);
      if(signal.aborted||generation!==loadGeneration.current)return;
      if(tasks.identityId!==identityId||tasks.projectId!==project.id||requirements.stories.some(s=>s.projectId!==project.id||s.boardId!==board.id))throw new AccountRequestError(403);
      hasSnapshot.current=true;setData(tasks);setStories(requirements.stories);setNotice('');
    }catch(error){
      if(signal.aborted||generation!==loadGeneration.current)return;
      if(denied(error)){hasSnapshot.current=false;setData(null);setStories(null);setNotice('当前账号已无权访问此看板。');}
      else if(!hasSnapshot.current)setNotice('看板暂时无法加载，请重试。');
    }
  },[board.id,cursor,identityId,project.id]);
  useEffect(()=>{hasSnapshot.current=false;setData(null);setStories(null);setNotice('');},[identityId,project.id,board.id,cursor]);
  useEffect(()=>{
    const controller=new AbortController();let active=true,busy=false;
    const refresh=async()=>{if(!active||busy)return;busy=true;await load(controller.signal);busy=false;};
    void refresh();const timer=window.setInterval(()=>void refresh(),1500);
    return()=>{active=false;++loadGeneration.current;controller.abort();window.clearInterval(timer);};
  },[load,revision]);
  const tasks=data?.tasks.filter(task=>task.boardId===board.id)??[];
  const query=search.trim().toLocaleLowerCase();
  const matchesText=(...values:string[])=>values.join(' ').toLocaleLowerCase().includes(query);
  const matchingStories=stories?.filter(story=>matchesText(story.title,story.body,story.reference??'',story.id))??[];
  const filtered=!!query||filter!=='all';
  const icons={pending:CircleDashed,assigned:Circle,running:LoaderCircle,review:Clock3,done:CircleCheck,failed:XCircle};
  return <section className="project-board original-board" aria-label="项目看板">
    {creating&&<CreateWorkDialog kind={creating} projectId={project.id} boardId={board.id} onClose={()=>setCreating(null)} onCreated={()=>{setCreating(null);setPages([]);setRevision(n=>n+1);}}/>}
    <header className="board-heading workspace-page-heading"><div><h1>{board.name}</h1><span>从需求，到可验收的成果</span></div>{project.role!=='viewer'&&<button type="button" className="primary-button" onClick={()=>setCreating('story')}><Plus size={16}/>新建故事</button>}</header>
    <section className="metrics" aria-label="看板概览">
      <div aria-label="需求故事"><span className="metric-icon lavender"><BookOpen size={18}/></span><span><small>需求故事</small><strong>{stories?.length??'—'}<em>个故事</em></strong></span></div>
      <div aria-label="正在执行"><span className="metric-icon blue"><Zap size={18}/></span><span><small>正在执行</small><strong>{data?tasks.filter(t=>t.status==='running').length:'—'}<em>个任务</em></strong></span></div>
      <div aria-label="等待验收" className="metric-review"><span className="metric-icon amber"><ShieldCheck size={18}/></span><span><small>等待验收</small><strong>{data?tasks.filter(t=>t.status==='review').length:'—'}<em>项待确认</em></strong></span></div>
      <div aria-label="执行失败" className="metric-failed"><span className="metric-icon"><XCircle size={18}/></span><span><small>执行失败</small><strong>{data?tasks.filter(t=>t.status==='failed').length:'—'}<em>项待处理</em></strong></span></div>
    </section>
    <div className="board-toolbar"><span className="board-tab"><Columns3 size={16}/>看板</span><span className="board-scope">本页任务</span><div className="toolbar-filters"><label className="board-search"><Search size={15}/><input aria-label="搜索任务或故事" placeholder="搜索标题、内容或编号" value={search} onChange={e=>setSearch(e.target.value)}/></label><label className="board-filter"><Settings2 size={15}/><select aria-label="筛选任务" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部任务</option>{Object.entries(taskStatusLabel).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>{filtered&&<button type="button" className="text-button board-clear" onClick={()=>{setSearch('');setFilter('all');}}>清除筛选</button>}<button type="button" className="board-icon-button" aria-label="刷新看板" onClick={()=>setRevision(n=>n+1)}><RefreshCw size={15}/></button></div></div>
    {notice&&<p role="alert" className="notice notice-error">{notice}</p>}
    {!data&&!notice&&<p role="status">正在读取看板…</p>}
    <div className="scrum-columns" tabIndex={0} role="region" aria-label="看板列，可横向滚动">
      {filter==='all'&&<section className="scrum-column story-column" aria-label="故事池列"><header><BookOpen size={15}/><h2>故事池</h2><span>{stories?matchingStories.length:'—'}</span>{project.role!=='viewer'&&<button type="button" className="board-icon-button" title="新建故事" aria-label="新建故事" onClick={()=>setCreating('story')}><Plus size={15}/></button>}</header>
        <div className="scrum-column-body">
        {stories&&!matchingStories.length&&<p className="compact-empty">{query?'没有匹配的故事':'暂无故事'}</p>}
        {matchingStories.map(story=><button className="scrum-card story-card" key={story.id} onClick={()=>onStories('list',story.id)}><span className="card-overline"><span><BookOpen size={12}/>{story.reference??'需求故事'}</span><span className="pill lavender">版本 {story.version}</span></span><strong>{story.title}</strong><BodyContent body={story.body} projectId={project.id}/><footer><span>查看与拆分</span><ArrowRight size={14}/></footer></button>)}
        </div>
      </section>}
      {Object.entries(taskStatusLabel).filter(([status])=>filter==='all'||filter===status).map(([status,label])=>{
        const matches=tasks.filter(task=>task.status===status&&matchesText(task.title,task.objective,task.id,'TASK-'+task.id.slice(0,6)));
        const Icon=icons[status as keyof typeof icons];
        return <section className={'scrum-column status-'+status} key={status} aria-label={label+'列'}><header><Icon size={15}/><h2>{label}</h2><span>{data?matches.length:'—'}</span>{status==='pending'&&project.role!=='viewer'&&<button type="button" className="board-icon-button" title="新建任务" aria-label="新建任务" onClick={()=>setCreating('task')}><Plus size={15}/></button>}</header>
          <div className="scrum-column-body">{data&&!matches.length&&<p className="compact-empty">{query?'没有匹配的任务':'暂无任务'}</p>}
          {matches.map(task=><button className={'scrum-card task-card '+(task.presentation?.recoveryRequired||task.status==='failed'?'needs-attention':task.status==='review'?'needs-review':'')} key={task.id} onClick={()=>onExecution(task.id)}>
            <span className="card-overline"><span className="task-code">TASK-{task.id.slice(0,6).toUpperCase()}</span>{task.presentation&&<span>{({high:'高优先级',normal:'普通',low:'低优先级'})[task.presentation.priority]}</span>}</span>
            {task.title&&<strong>{task.title}</strong>}<BodyContent body={task.objective} projectId={project.id}/><span className="card-tags">{task.requiredCapabilities.map(capability=><span className="tag" key={capability}>{capability==='coding'?'代码':capability==='writing'?'文字':capability}</span>)}{Boolean(task.presentation?.dependencyCount)&&<span className="tag">{task.presentation!.dependencyCount} 项依赖</span>}</span>
            <TaskAttention status={task.status} recoveryRequired={task.presentation?.recoveryRequired}/>
            <footer><TaskPeople value={task.presentation}/><ArrowRight size={14} aria-label={task.execution?.summary?'查看成果':'查看任务'}/></footer></button>)}
          </div>
        </section>;
      })}
    </div>
    {data&&(pages.length>0||data.hasMore)&&<div className="form-actions"><button className="secondary-button" disabled={!pages.length} onClick={()=>setPages(pages.slice(0,-1))}>上一页</button><span className="field-hint">第 {pages.length+1} 页</span><button className="secondary-button" disabled={!data.nextCursor} onClick={()=>{if(data.nextCursor)setPages([...pages,data.nextCursor]);}}>下一页</button></div>}
  </section>;
}
