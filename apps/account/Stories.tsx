import RequiredMark from './RequiredMark';
import {useCallback,useContext,useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowLeft,Clock3,FileText,Plus} from './Icons';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import TaskPublication from './TaskPublication';
import {PageIdentity,usePageState,usePageRef,writePageState} from './page-state';
import CreateWorkDialog from './CreateWorkDialog';
import BodyEditor from './BodyEditor';
import BodyContent from './BodyContent';

const storySchema=z.object({id:z.uuid(),projectId:z.uuid(),boardId:z.uuid(),title:z.string(),body:z.string(),version:z.number().int().positive(),authorId:z.uuid(),number:z.number().int().nullable(),reference:z.string().nullable()}).strict();
const revisionSchema=z.object({title:z.string(),body:z.string(),version:z.number().int().positive(),authorId:z.uuid()}).strict();
const listSchema=z.object({stories:z.array(storySchema)}).strict();
const detailSchema=z.object({story:storySchema}).strict();
const historySchema=z.object({revisions:z.array(revisionSchema)}).strict();
type Story=z.infer<typeof storySchema>;
type Notice={error:boolean;text:string}|null;

function messageFor(error:unknown,fallback:string){return denied(error)?'登录已失效或当前账号无权访问这个故事池。':fallback;}

function StoryEditor({projectId,story,onSaved,onBack,onDenied,onExecution,readOnly=false}:{readOnly?:boolean;projectId:string;story:Story;onSaved:(story:Story)=>void;onBack:()=>void;onDenied:()=>void;onExecution:(taskId:string)=>void}){
  const scope='story.'+story.id+'.edit';
  const [draft,setDraft]=usePageState(scope,z.object({base:storySchema.extend({number:z.number().int().nullable().default(null),reference:z.string().nullable().default(null)}),title:z.string().max(200),body:z.string().max(12000)}).nullable(),null);
  const [saved,setSaved]=useState(story),current=draft?.base??saved,title=draft?.title??saved.title,body=draft?.body??saved.body;
  const setTitle=(value:string)=>setDraft(previous=>({base:previous?.base??saved,title:value,body:previous?.body??saved.body}));
  const setBody=(value:string)=>setDraft(previous=>({base:previous?.base??saved,title:previous?.title??saved.title,body:value}));
  const [mode,setMode]=usePageState('story.'+story.id+'.page',z.enum(['edit','history','publication']),'edit'),[revisions,setRevisions]=useState<z.infer<typeof revisionSchema>[]|null>(null);
  const [busy,setBusy]=useState(false),[conflict,setConflict]=useState(false),[notice,setNotice]=useState<Notice>(null);
  const [uploading,setUploading]=useState(false);
  const [latest,setLatest]=useState<Story|null>(null);
  const pending=usePageRef(scope+'.pending',z.object({fingerprint:z.string(),input:z.object({title:z.string(),body:z.string(),expectedVersion:z.number().int().positive(),requestId:z.uuid()})}).nullable(),null);
  const alive=useRef(true);
  const loadOperation=useRef(0),controller=useRef<AbortController|null>(null);
  useEffect(()=>{alive.current=true;if(mode==='history')void showHistory();return()=>{alive.current=false;controller.current?.abort();};},[]);
  function back(){
    setMode('edit');onBack();
  }
  async function loadLatest(){
    const operation=++loadOperation.current;controller.current?.abort();controller.current=new AbortController();
    setBusy(true);setNotice(null);
    try{
      const result=await accountRequest('/projects/'+projectId+'/stories/'+story.id,detailSchema,{signal:controller.current.signal});
      if(!alive.current||operation!==loadOperation.current)return;
      if(result.story.projectId!==projectId||result.story.id!==story.id)throw Error('Story scope mismatch');
      setLatest(result.story);
      setNotice({error:true,text:'故事已被其他成员修改。请对照当前版本，选择要保留的内容后再保存。'});
    }catch(error){if(alive.current&&operation===loadOperation.current&&!(error instanceof DOMException&&error.name==='AbortError')){
      if(denied(error))onDenied();else setNotice({error:true,text:'最新版本暂时无法加载，请重试。'});
    }}
    finally{if(alive.current&&operation===loadOperation.current)setBusy(false);}
  }
  async function save(event:FormEvent){
    event.preventDefault();if(busy||conflict||uploading||body.length>12000)return;
    const normalized=title.trim();if(!normalized||!body)return;
    const fingerprint=JSON.stringify({title:normalized,body,expectedVersion:current.version});
    if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,input:{title:normalized,body,expectedVersion:current.version,requestId:crypto.randomUUID()}};
    setBusy(true);setNotice(null);
    try{
      const result=await accountRequest('/projects/'+projectId+'/stories/'+story.id,detailSchema,{body:pending.current.input});
      if(!alive.current)return;
      setSaved(result.story);setDraft(null);pending.current=null;onSaved(result.story);
      setNotice({error:false,text:'故事已保存为新版本。'});
    }catch(error){if(alive.current){
      if(error instanceof AccountRequestError&&error.status===409){setConflict(true);pending.current=null;await loadLatest();}
      else if(denied(error))onDenied();
      else setNotice({error:true,text:'故事结果未能确认，请重试；内容未改变时会沿用同一请求标识。'});
    }}finally{if(alive.current)setBusy(false);}
  }
  async function showHistory(){
    const operation=++loadOperation.current;controller.current?.abort();controller.current=new AbortController();
    setMode('history');setRevisions(null);setNotice(null);
    try{
      const result=await accountRequest('/projects/'+projectId+'/stories/'+story.id+'/revisions',historySchema,{signal:controller.current.signal});
      if(alive.current&&operation===loadOperation.current)setRevisions(result.revisions);
    }catch(error){if(alive.current&&operation===loadOperation.current){
      if(denied(error))onDenied();else setNotice({error:true,text:'历史版本暂时无法加载，请重试。'});
    }}
  }
  if(mode==='publication')return <TaskPublication key={current.id+':'+current.version} readOnly={readOnly} projectId={projectId} story={current} onBack={()=>setMode('edit')} onDenied={onDenied} onExecution={onExecution}/>;
  if(mode==='history')return <section className="story-detail" aria-label="故事历史">
    <header className="workspace-page-heading"><div><h1>{current.title}</h1><span>修改历史</span></div><Clock3 size={18} aria-hidden="true"/></header>
    {notice&&<div className="notice notice-error" role="alert">{notice.text}</div>}
    {revisions===null&&!notice?<p className="loading-message" role="status">正在读取历史版本…</p>:<ol className="revision-list">{revisions?.map(revision=><li key={revision.version}><div><strong>版本 {revision.version}</strong><span>作者 {revision.authorId.slice(0,8)}</span></div><h5>{revision.title}</h5><BodyContent body={revision.body} projectId={projectId}/></li>)}</ol>}
  </section>;
  return <section className="story-detail" aria-label="编辑故事">
    <header className="workspace-page-heading"><div><h1>{current.title}</h1><span>版本 {current.version}</span></div></header>
    {notice&&<div className={'notice notice-'+(notice.error?'error':'success')} role={notice.error?'alert':'status'}>{notice.text}</div>}
    {conflict&&<section aria-label="版本冲突">{latest?<><h4>当前版本 {latest.version}：{latest.title}</h4><BodyContent body={latest.body} projectId={projectId}/><div className="form-actions">
      <button className="secondary-button" type="button" onClick={()=>{setSaved(latest);setDraft({base:latest,title,body});setConflict(false);onSaved(latest);setLatest(null);setNotice(null);}}>保留我的修改</button>
      <button className="secondary-button" type="button" onClick={()=>{setSaved(latest);setDraft(null);setConflict(false);onSaved(latest);setLatest(null);setNotice(null);}}>使用当前版本</button>
    </div></>:<button className="secondary-button" type="button" disabled={busy} onClick={()=>void loadLatest()}>重试核对</button>}</section>}
    <form className="story-form" onSubmit={save}>
      <label htmlFor={'story-title-'+story.id}>故事标题<RequiredMark/></label><input id={'story-title-'+story.id} maxLength={200} required value={title} disabled={busy||readOnly} onChange={event=>setTitle(event.target.value)}/>
      <div className="field-label">故事正文<RequiredMark/></div>{readOnly?<BodyContent body={body} projectId={projectId}/>:<BodyEditor projectId={projectId} value={body} onChange={setBody} label="故事正文" disabled={busy} maxLength={12000} onUploading={setUploading}/>}

      <div className="form-actions">{!readOnly&&<button className="primary-button" type="submit" disabled={busy||conflict||uploading||body.length>12000||!body.trim()}>{busy?'保存中…':'保存修改'}</button>}
        <button className="secondary-button" type="button" disabled={busy} onClick={()=>void showHistory()}><Clock3 size={15} aria-hidden="true"/>查看历史</button>
        <button className="secondary-button" type="button" disabled={busy||conflict||title!==current.title||body!==current.body}
          onClick={()=>{++loadOperation.current;controller.current?.abort();setMode('publication');}}>{readOnly?'发布记录':'拆分任务'}</button></div>
    </form>
  </section>;
}

export default function Stories({project,board,onBack,onExecution,initialMode='list'}:{project:{id:string;name:string;role?:string};board:{id:string;name:string};onBack:()=>void;onExecution:(taskId:string)=>void;initialMode?:'list'|'create'}){
  const identityId=useContext(PageIdentity);
  const scope='stories.'+project.id+'.'+board.id;
  const [stories,setStories]=useState<Story[]|null>(null),[mode,setMode]=usePageState(scope+'.page',z.enum(['list','create','detail']),initialMode);
  const [selectedId,setSelectedId]=usePageState(scope+'.selected',z.uuid().nullable(),null);
  const [selected,setSelected]=useState<Story|null>(null),[notice,setNotice]=useState<Notice>(null);
  const alive=useRef(true),operation=useRef(0),controller=useRef<AbortController|null>(null);
  const path='/projects/'+project.id+'/boards/'+board.id+'/stories';
  const load=useCallback(async()=>{
    const generation=++operation.current;controller.current?.abort();controller.current=new AbortController();
    const result=await accountRequest(path,listSchema,{signal:controller.current.signal});
    if(!alive.current||generation!==operation.current)return null;
    if(result.stories.some(story=>story.projectId!==project.id||story.boardId!==board.id))throw Error('Story list scope mismatch');
    setStories(result.stories);
    if(selectedId){const restored=result.stories.find(item=>item.id===selectedId);if(restored)setSelected(restored);else{setSelectedId(null);setMode('list');}}
    return result.stories;
  },[board.id,path,project.id]);
  const loadForDisplay=useCallback(async()=>{
    setNotice(null);
    try{await load();}catch(error){if(alive.current&&!(error instanceof DOMException&&error.name==='AbortError')){
      setStories(null);setNotice({error:true,text:messageFor(error,'故事列表暂时无法加载，请重试。')});
    }}
  },[load]);
  useEffect(()=>{alive.current=true;void loadForDisplay();return()=>{alive.current=false;++operation.current;controller.current?.abort();};},[loadForDisplay]);
  function cancelCreate(){
    setMode('list');setNotice(null);
  }
  function leave(){
    setMode('list');setSelectedId(null);onBack();
  }
  function saved(story:Story){setStories(current=>current?.map(item=>item.id===story.id?story:item)??[story]);setSelected(story);}
  const accessDenied=useCallback(()=>{
    ++operation.current;controller.current?.abort();setStories(null);setSelected(null);setSelectedId(null);setMode('list');
    setNotice({error:true,text:'登录已失效或当前账号无权访问这个故事池。'});
  },[setSelectedId,setMode]);
  if(mode==='detail'&&selected)return <StoryEditor readOnly={project.role==='viewer'} key={project.id+':'+selected.id} projectId={project.id} story={selected} onSaved={saved} onDenied={accessDenied} onExecution={onExecution} onBack={()=>{setMode('list');setSelected(null);setSelectedId(null);setNotice(null);void loadForDisplay();}}/>;
  return <section aria-label="故事池">
    <header className="workspace-page-heading"><div><h1>故事池</h1><span>{project.name} · {board.name}</span></div></header>
    {notice&&<div className={'notice notice-'+(notice.error?'error':'success')} role={notice.error?'alert':'status'}>{notice.text}</div>}
    {mode==='create'&&project.role!=='viewer'&&<CreateWorkDialog kind="story" projectId={project.id} boardId={board.id} onClose={cancelCreate} onCreated={()=>{setMode('list');void loadForDisplay();}}/>}
    <>
      {project.role!=='viewer'&&<div className="toolbar"><button className="primary-button" type="button" onClick={()=>{setMode('create');setNotice(null);}}><Plus size={15} aria-hidden="true"/>新建故事</button></div>}
      {stories===null&&!notice?.error?<p className="loading-message" role="status">正在读取故事…</p>:stories?.length?<ul className="story-list">{stories.map(story=><li key={story.id}>
        <FileText size={18} aria-hidden="true"/><button className="text-button" type="button" onClick={()=>{++operation.current;controller.current?.abort();if(identityId)writePageState(identityId,'story.'+story.id+'.page','edit');setSelected(story);setSelectedId(story.id);setMode('detail');setNotice(null);}}>{story.title}</button><span>{story.reference??''} · 版本 {story.version}</span><BodyContent body={story.body} projectId={project.id}/>
      </li>)}</ul>:<p className="compact-empty">这个看板还没有故事</p>}
    </>
  </section>;
}
