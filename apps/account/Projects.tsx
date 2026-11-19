import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {LayoutDashboard,UsersRound} from './Icons';
import {Bot, Settings} from 'lucide-react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import ProjectSettings from './ProjectSettings';
import ProjectMembers from './ProjectMembers';
import ProjectAgents from './ProjectAgents';
import Stories from './Stories';
import Execution from './Execution';
import ProjectBoard from './ProjectBoard';
import {usePageState,writePageState,readPageState} from './page-state';

import {projectSchema} from './hierarchy';
import {readHierarchyRoute,writeHierarchyRoute,projectManagementPage,type ProjectPage} from './hierarchy-route';
const boardSchema=z.object({id:z.uuid(),name:z.string(),isDefault:z.boolean()}).strict();
const liveBoardSchema=boardSchema.extend({archived:z.boolean()}).strict();
const detailSchema=z.object({project:projectSchema,boards:z.array(boardSchema)}).strict();
const boardListSchema=z.object({projectId:z.uuid(),defaultBoardId:z.uuid(),boards:z.array(liveBoardSchema)}).strict();
const projectListSchema=z.object({projects:z.array(projectSchema)}).strict();
type Project=z.infer<typeof projectSchema>;
type Detail=z.infer<typeof detailSchema>;
type Notice={error:boolean;text:string}|null;


function ProjectDetail({identityId,organization,detail,boardId,view,boardEntry,onBack,onProject,onPage}:{onPage:(page:ProjectPage,taskId?:string)=>void;onProject:(project:Project)=>void;identityId:string;organization:{id:string;name:string};detail:Detail;boardId:string;view:'board'|'settings'|'members'|'agents';boardEntry:number;onBack:()=>void}){
  const scope='project.'+detail.project.id;
  const [page,setPage]=usePageState(scope+'.page',z.enum(['board','stories','create-story','execution']),'board');
  const [boardPages,setBoardPages]=usePageState(scope+'.pages',z.array(z.string().max(4096)).max(100),[]);
  const [executionEntry,setExecutionEntry]=usePageState(scope+'.task',z.object({taskId:z.uuid(),pages:z.array(z.string().max(4096)).max(100)}).nullable(),null);
  const currentBoard=detail.boards.find(b=>b.id===boardId)??detail.boards[0];
  const editingBoard=useRef(currentBoard);if(page==='board')editingBoard.current=currentBoard;
  function openStories(mode:'list'|'create'='list',storyId?:string){
    if(!currentBoard)return;
    const storiesScope='stories.'+detail.project.id+'.'+currentBoard.id;
    writePageState(identityId,storiesScope+'.page',storyId?'detail':mode);writePageState(identityId,storiesScope+'.selected',storyId??null);
    if(storyId)writePageState(identityId,'story.'+storyId+'.page','edit');
    setPage(mode==='create'?'create-story':'stories');onPage(mode==='create'?'create-story':'stories');
  }
  function openExecution(taskId?:string){
    const pages=taskId?[...boardPages]:[];
    writePageState(identityId,scope+'.execution-pages',pages);
    setExecutionEntry(taskId?{taskId,pages}:null);setPage('execution');onPage(view==='settings'?'automatic':'execution',taskId);
  }
  const entry=useRef({boardEntry,view});
  useEffect(()=>{if(entry.current.boardEntry!==boardEntry||entry.current.view!==view){entry.current={boardEntry,view};setPage('board');}},[boardEntry,view,setPage]);
  if(view==='members')return <ProjectMembers organizationId={organization.id} project={detail.project}/>;
  if(view==='agents')return <ProjectAgents identityId={identityId} project={detail.project} boardId={boardId} onTab={tab=>onPage(tab==='records'?'automatic':'agents')}/>;
  if(view==='settings')return <ProjectSettings project={detail.project} onChanged={onProject}/>;
  if(page==='execution')return <Execution identityId={identityId} project={detail.project} boardId={boardId} initialPages={executionEntry?.pages} focusTaskId={executionEntry?.taskId} onBack={()=>{setPage('board');onPage('board');}}/>;
  if((page==='stories'||page==='create-story')&&editingBoard.current)return <Stories key={detail.project.id+':'+editingBoard.current.id} project={detail.project} board={editingBoard.current} initialMode={page==='create-story'?'create':'list'} onExecution={openExecution} onBack={()=>{setPage('board');onPage('board');}}/>;
  return <>
    {currentBoard?<ProjectBoard key={detail.project.id+':'+currentBoard.id} identityId={identityId} project={detail.project} board={currentBoard} pages={boardPages} setPages={setBoardPages} onStories={openStories} onExecution={openExecution} onBack={onBack}/>:<p className="compact-empty">当前项目没有可访问的看板。</p>}
  </>;
}

export default function Projects({identityId,organization,view,boardVisible,navigationTarget,boardEntry,onOpenBoard,onSettings,onBack}:{identityId:string;organization:{id:string;name:string};view:'board'|'settings';boardVisible:boolean;navigationTarget:HTMLElement|null;boardEntry:number;onOpenBoard:()=>void;onSettings:()=>void;onBack:()=>void}){
  const [projects,setProjects]=useState<Project[]|null>(null),[selected,setSelected]=useState<Detail|null>(null);
  const scope='projects.'+organization.id;
  const [subview,setSubview]=usePageState(scope+'.subview',z.enum(['board','settings','members','agents']),'board');
  const [selectedId,setSelectedId]=usePageState(scope+'.selected',z.uuid().nullable(),null);
  const [selectedBoardId,setSelectedBoardId]=usePageState(scope+'.board',z.union([z.literal(''),z.uuid()]),'');
  const [reading,setReading]=useState(false),[revision,setRevision]=useState(0);
  const [notice,setNotice]=useState<Notice>(null);
  const alive=useRef(true),openGeneration=useRef(0),openController=useRef<AbortController|null>(null);
  const path='/organizations/'+organization.id+'/projects';
  function routePage(page:ProjectPage,taskId?:string,detail=selected,boardId=selectedBoardId,replace=false){
    if(detail&&boardId)writeHierarchyRoute({organizationId:organization.id,section:projectManagementPage(page)?'projects':'boards',project:{id:detail.project.id,boardId,page,...(taskId?{taskId}:{})}},replace);
  }
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;++openGeneration.current;openController.current?.abort();};},[]);
  useEffect(()=>{
    const controller=new AbortController();setReading(true);setNotice(null);setProjects(null);setSelected(null);++openGeneration.current;
    void accountRequest(path,projectListSchema,{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted){setProjects(result.projects);const restored=result.projects.find(project=>project.id===selectedId);if(restored)void open(restored,selectedBoardId||undefined,false,true);else if(selectedId){setSelectedId(null);const route=readHierarchyRoute(window.location.hash);if(route&&route!=='invalid'&&route.organizationId&&route.project)throw new AccountRequestError(403);}}})
      .catch(error=>{if(!controller.signal.aborted)fail(error);})
      .finally(()=>{if(!controller.signal.aborted)setReading(false);});
    return()=>controller.abort();
  },[path,revision]);
  function fail(error:unknown){
    if(!alive.current)return;const accessDenied=denied(error);
    if(accessDenied){setProjects(null);setSelected(null);}
    setNotice({error:true,text:accessDenied?'登录已失效或当前账号无权访问，请返回项目列表或重新登录。':'项目暂时无法加载，请重试。'});
  }
  async function open(project:Project,boardId?:string,fromNavigation=false,restore=false){
    const generation=++openGeneration.current;openController.current?.abort();openController.current=new AbortController();setReading(true);setNotice(null);
    if(fromNavigation){setSubview('board');onOpenBoard();}
    try{
      const result=await accountRequest('/projects/'+project.id,detailSchema,{signal:openController.current.signal});
      if(!alive.current||generation!==openGeneration.current)return;
      if(result.project.organizationId!==organization.id||result.project.id!==project.id)throw Error('Project scope mismatch');
      if(boardId&&!result.boards.some(board=>board.id===boardId))throw new AccountRequestError(403);
      const route=readHierarchyRoute(window.location.hash);
      if(restore&&route&&route!=='invalid'&&route.organizationId&&route.project&&result.project.role==='viewer'&&route.project.page!=='members'&&projectManagementPage(route.project.page))throw new AccountRequestError(403);
      if(!restore){setSubview('board');writePageState(identityId,'project.'+result.project.id+'.page','board');}
      setSelectedBoardId(boardId??result.project.defaultBoardId);
      setSelected(result);
      setSelectedId(result.project.id);
      if(!restore)routePage(fromNavigation||view==='board'?'board':'settings',undefined,result,boardId??result.project.defaultBoardId);
      else if(route&&route!=='invalid'&&route.organizationId&&route.section==='boards'&&!route.project){
        const page=readPageState(identityId,'project.'+result.project.id+'.page',z.enum(['board','stories','create-story','execution']),'board');
        const task=readPageState(identityId,'project.'+result.project.id+'.task',z.object({taskId:z.uuid(),pages:z.array(z.string())}).nullable(),null);
        routePage(page,page==='execution'?task?.taskId:undefined,result,boardId??result.project.defaultBoardId,true);
      }
    }catch(error){if(generation===openGeneration.current){setSelected(null);fail(error);}}finally{if(alive.current&&generation===openGeneration.current)setReading(false);}
  }
  useEffect(()=>{
    const projectId=selected?.project.id;if(!projectId)return;
    const controller=new AbortController();let active=true,busy=false;
    const refresh=async()=>{if(!active||busy)return;busy=true;
      try{
        const result=await accountRequest('/projects/'+projectId+'/boards',boardListSchema,{signal:controller.signal});
        if(!active||result.projectId!==projectId)return;
        setSelected(current=>current?.project.id===projectId?{...current,boards:result.boards}:current);
        setSelectedBoardId(current=>result.boards.some(board=>board.id===current)?current:result.defaultBoardId);
      }catch(error){if(active&&denied(error))fail(error);}finally{busy=false;}
    };
    void refresh();const timer=window.setInterval(()=>void refresh(),1500);
    return()=>{active=false;controller.abort();window.clearInterval(timer);};
  },[selected?.project.id]);
  const navigation=navigationTarget&&selected&&createPortal(<nav className="project-tree" aria-label="项目导航">
    <div className="project-tree-heading">{organization.name}</div>
    <button type="button" aria-label="项目 Scrum 看板" aria-current={boardVisible&&view==='board'?'page':undefined} onClick={()=>{setSelectedBoardId(selected.project.defaultBoardId);setSubview('board');onOpenBoard();routePage('board',undefined,selected,selected.project.defaultBoardId);}}><LayoutDashboard size={17}/>Scrum 看板</button>
    {(['agents','members','settings'] as const).filter(child=>selected.project.role!=='viewer'||child==='members').map(child=><button key={child} type="button" aria-current={boardVisible&&view==='settings'&&subview===child?'page':undefined} onClick={()=>{if(child==='agents')writePageState(identityId,'project.'+selected.project.id+'.coordinator-tab','agents');setSubview(child);onSettings();routePage(child);}}>{child==='agents'?<Bot size={17}/>:child==='members'?<UsersRound size={17}/>:<Settings size={17}/>}<span>{child==='agents'?'项目协调Agent':child==='members'?'成员管理':'项目设置'}</span></button>)}
  </nav>,navigationTarget);
  if(selected)return <>{navigation}<ProjectDetail key={organization.id+':'+selected.project.id} identityId={identityId} organization={organization} detail={selected} boardId={selectedBoardId} view={(selected.project.role==='viewer'&&subview!=='members')||view==='board'?'board':subview==='board'?'settings':subview} boardEntry={boardEntry} onPage={routePage} onProject={project=>{setSelected(current=>current?{...current,project}:current);setProjects(current=>current?.map(p=>p.id===project.id?project:p)??null);}} onBack={onBack}/></>;
  return <section aria-label="项目加载状态">{notice?<div className="notice notice-error" role="alert">{notice.text}</div>:<p role="status">正在读取项目…</p>}{!reading&&<button className="secondary-button" type="button" onClick={()=>setRevision(value=>value+1)}>重新加载项目</button>}</section>;
}
