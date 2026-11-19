import RequiredMark from './RequiredMark';
import HelpTip from './HelpTip';
import StoryAssistance from './StoryAssistance';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {Plus} from './Icons';
import {z} from 'zod';
import {publicationInput,type PublicationInput} from '../../services/account/task-publication-input';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {taskStatusSchema,taskStatusLabel} from './task-status';
import {usePageState} from './page-state';

const summarySchema=z.object({id:z.uuid(),storyVersion:z.number().int().positive(),authorId:z.uuid(),taskCount:z.number().int().min(1).max(20)}).strict();
const listSchema=z.object({publications:z.array(summarySchema).max(50),hasMore:z.boolean()}).strict();
const resultSchema=z.object({publication:z.object({
  id:z.uuid(),projectId:z.uuid(),boardId:z.uuid(),storyId:z.uuid(),storyVersion:z.number().int().positive(),authorId:z.uuid(),
  sourceStory:z.object({title:z.string(),body:z.string(),version:z.number().int().positive()}).strict(),
  tasks:z.array(z.object({id:z.uuid(),key:z.string(),title:z.string(),objective:z.string(),acceptanceCriteria:z.string(),
    requiredCapabilities:z.array(z.string()),priority:z.enum(['low','normal','high']),status:taskStatusSchema,dependsOn:z.array(z.uuid()),
  }).strict()).min(1).max(20),
}).strict()}).strict();
type Publication=z.infer<typeof resultSchema>['publication'];
type Draft={key:string;title:string;objective:string;acceptanceCriteria:string;capabilities:string;priority:'low'|'normal'|'high';dependsOn:string[]};
const draftSchema=z.object({key:z.string().max(40),title:z.string().max(200),objective:z.string().max(4000),acceptanceCriteria:z.string().max(4000),capabilities:z.string().max(409),priority:z.enum(['low','normal','high']),dependsOn:z.array(z.string().max(40)).max(19)}).strict();
const blank=(key:string):Draft=>({key,title:'',objective:'',acceptanceCriteria:'',capabilities:'',priority:'normal',dependsOn:[]});

export default function TaskPublication({projectId,story,onBack,onDenied,onExecution,readOnly=false}:{
  readOnly?:boolean;
  projectId:string;story:{id:string;boardId:string;title:string;body:string;version:number};onBack:()=>void;onDenied:()=>void;onExecution:(taskId:string)=>void;
}){
  const scope='publication.'+projectId+'.'+story.id+'.'+story.version;
  const [tasks,setTasks]=usePageState<Draft[]>(scope+'.tasks',z.array(draftSchema).max(20),[]),[confirmed,setConfirmed]=useState(false);
  const [editingKey,setEditingKey]=useState<string|null>(null),[invalidKey,setInvalidKey]=useState<string|null>(null);
  const [manual,setManual]=usePageState(scope+'.manual',z.boolean(),false);
  const [stage,setStage]=usePageState(scope+'.stage',z.enum(['draft','review']),'draft');
  const [savedPending,setSavedPending]=usePageState(scope+'.pending',publicationInput.nullable(),null);
  const [selectedPublication,setSelectedPublication]=usePageState(scope+'.result',z.uuid().nullable(),null);
  const restorePublication=useRef(selectedPublication);
  const [history,setHistory]=useState<z.infer<typeof listSchema>|null>(null),[result,setResult]=useState<Publication|null>(null);
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(!!savedPending),[conflict,setConflict]=useState(false);
  const alive=useRef(true),sequence=useRef(0),controller=useRef<AbortController|null>(null),nextKey=useRef(2);
  const pending=useRef<PublicationInput|null>(savedPending),path='/projects/'+projectId+'/stories/'+story.id+'/publications';
  const published=history?.publications.some(item=>item.storyVersion===story.version)??false;
  const locked=busy||uncertain||published;
  const hasDraft=tasks.some(task=>task.title||task.objective||task.acceptanceCriteria||task.capabilities||task.priority!=='normal'||task.dependsOn.length);
  const showEditor=manual||hasDraft||uncertain||stage==='review';
  const invalidate=()=>{++sequence.current;controller.current?.abort();};
  const checkScope=(publication:Publication)=>{
    if(publication.projectId!==projectId||publication.boardId!==story.boardId||publication.storyId!==story.id||
      publication.sourceStory.version!==publication.storyVersion)throw Error('Publication scope mismatch');
  };
  const load=useCallback(async()=>{
    const operation=++sequence.current;controller.current?.abort();controller.current=new AbortController();
    setBusy(true);setNotice('');
    try{
      const snapshot=await accountRequest(path,listSchema,{signal:controller.current.signal});
      if(alive.current&&operation===sequence.current){setHistory(snapshot);return snapshot;}
    }catch(error){if(alive.current&&operation===sequence.current&&!(error instanceof DOMException&&error.name==='AbortError')){
      if(denied(error))onDenied();else{setHistory(null);setNotice('发布记录暂时无法加载，请重试。');}
    }}finally{if(alive.current&&operation===sequence.current)setBusy(false);}
  },[path,onDenied]);
  useEffect(()=>{alive.current=true;void load().then(snapshot=>{
    if(!alive.current||!snapshot)return;
    const id=restorePublication.current??(pending.current?snapshot.publications.find(item=>item.storyVersion===story.version)?.id:null);
    restorePublication.current=null;if(id)void view(id);
  });return()=>{alive.current=false;++sequence.current;controller.current?.abort();};},[load]);
  function change(key:string,patch:Partial<Draft>){
    setTasks(current=>current.map(task=>task.key===key?{...task,...patch}:task));setConfirmed(false);
  }
  async function publish(event:FormEvent){
    event.preventDefault();if(busy||conflict||published||!history||(stage==='review'&&!confirmed&&!uncertain))return;
    if(!pending.current){
      const input=publicationInput.safeParse({requestId:crypto.randomUUID(),expectedVersion:story.version,tasks:tasks.map(({capabilities,...task})=>({
        ...task,requiredCapabilities:capabilities.split(',').map(value=>value.trim()).filter(Boolean),
      }))});
      if(!input.success){const index=input.error.issues.find(issue=>typeof issue.path[1]==='number')?.path[1];const key=tasks[typeof index==='number'?index:0]?.key??null;setEditingKey(key);setInvalidKey(key);setNotice('请补齐任务信息；能力使用小写英文标识、逗号分隔，依赖不能重复、自指或形成循环。');return;}
      if(new TextEncoder().encode(JSON.stringify(input.data)).byteLength>96*1024){setNotice('本批任务内容过大，请精简到 96 KiB 以内。');return;}
      if(stage==='draft'){setStage('review');setNotice('');return;}
      pending.current=input.data;setSavedPending(input.data);
    }
    invalidate();setBusy(true);setNotice('');
    try{
      const response=await accountRequest(path,resultSchema,{body:pending.current});
      if(!alive.current)return;checkScope(response.publication);
      if(response.publication.storyVersion!==story.version)throw Error('Publication revision mismatch');
      setResult(response.publication);setSelectedPublication(response.publication.id);setUncertain(false);pending.current=null;setSavedPending(null);
      setHistory(current=>({publications:[{id:response.publication.id,storyVersion:story.version,
        authorId:response.publication.authorId,taskCount:response.publication.tasks.length},
        ...(current?.publications??[]).filter(item=>item.id!==response.publication.id)].slice(0,50),
        hasMore:current?.hasMore??false}));
    }catch(error){if(alive.current){
      if(denied(error))onDenied();
      else if(error instanceof AccountRequestError&&error.status===409){setConflict(true);setUncertain(false);setSavedPending(null);setNotice('故事版本已变化或该版本已有发布。草稿已保留，请查看发布记录，或返回故事列表重新进入后核对。');}
      else if(error instanceof AccountRequestError&&[400,413].includes(error.status)){pending.current=null;setSavedPending(null);setUncertain(false);setNotice('任务内容未通过校验，请检查字段、依赖和内容长度后重新确认。');}
      else{setUncertain(true);setNotice('发布结果未能确认。已锁定本次内容，请重试确认结果，不要另建一批任务。');}
    }}finally{if(alive.current)setBusy(false);}
  }
  async function view(id:string){
    const operation=++sequence.current;controller.current?.abort();controller.current=new AbortController();setBusy(true);
    try{
      const response=await accountRequest('/projects/'+projectId+'/publications/'+id,resultSchema,{signal:controller.current.signal});
      if(!alive.current||operation!==sequence.current)return;checkScope(response.publication);
      if(response.publication.id!==id)throw Error('Publication id mismatch');setResult(response.publication);setSelectedPublication(id);
      if(response.publication.storyVersion===story.version){pending.current=null;setSavedPending(null);setUncertain(false);}
    }catch(error){if(alive.current&&operation===sequence.current&&!(error instanceof DOMException&&error.name==='AbortError')){
      if(denied(error))onDenied();else setNotice('发布详情暂时无法加载，请重试。');
    }}finally{if(alive.current&&operation===sequence.current)setBusy(false);}
  }
  function back(){
    onBack();
  }
  return <section className="story-detail" aria-label="任务拆分与发布">
    <header className="workspace-page-heading"><div><h1>{result?'发布结果':stage==='draft'?'拆分任务':'待发布任务'}</h1><span>{story.title} · 版本 {story.version}</span><HelpTip label="发布任务说明">拆分只产生草稿，可修改、添加和移除任务。人工发布后才创建待领取任务，满足执行条件后自动分配。</HelpTip></div></header>
    <details className="publication-source"><summary>故事原文</summary><BodyContent body={story.body} projectId={projectId}/></details>
    {!readOnly&&!published&&<StoryAssistance projectId={projectId} storyId={story.id} storyVersion={story.version} disabled={locked||conflict||!history} canAutoApply={!showEditor}
      currentProposal={{tasks:tasks.map(({capabilities,...task})=>({...task,requiredCapabilities:capabilities.split(',').map(value=>value.trim()).filter(Boolean)}))}}
      onApply={proposal=>{setTasks(proposal.tasks.map(({requiredCapabilities,...task})=>({...task,capabilities:requiredCapabilities.join(',')})));setStage('draft');setConfirmed(false);setEditingKey(null);setInvalidKey(null);}}/>}
    {notice&&<div className="notice notice-error" role="alert">{notice}</div>}
    {readOnly?null:published?(!result&&<p className="notice notice-success" role="status">这个故事版本已发布。后续修改故事不会改变已发布任务。</p>):!showEditor?<button type="button" className="text-button" disabled={locked||conflict} onClick={()=>{setTasks([blank('task1')]);setManual(true);setEditingKey('task1');}}>手工拆分</button>:<form className="story-form publication-form" noValidate onSubmit={publish} aria-label="确认任务拆分">
      <h2 className="publication-heading">任务草稿 <span>{tasks.length}</span></h2>
      {tasks.map((task,index)=><details className="publication-task" key={task.key} open={editingKey===task.key} onToggle={event=>{if(event.currentTarget.open)setEditingKey(task.key);else setEditingKey(current=>current===task.key?null:current);}}>
        <summary><div><strong>{task.title||`任务 ${index+1}`}</strong>{task.objective&&<p>{task.objective}</p>}</div><span>{editingKey===task.key?'收起':'编辑'}</span></summary>
        <fieldset className="publication-task-editor" disabled={locked}>
        <legend className="sr-only">任务 {index+1}</legend>
        {(['title','objective','acceptanceCriteria'] as const).map((field,fieldIndex)=>{
          const label=['标题','目标','验收标准'][fieldIndex],accessibleLabel=`任务 ${index+1} ${label}`,id=task.key+'-'+field;
          return <div key={field}><div className="field-label"><label htmlFor={id}>{label}<RequiredMark/></label></div>{field==='objective'||field==='acceptanceCriteria'
            ?<textarea id={id} aria-label={accessibleLabel} value={task[field]} maxLength={4000} required onChange={event=>change(task.key,{[field]:event.target.value})}/>
            :<input id={id} aria-label={accessibleLabel} value={task[field]} maxLength={200} required onChange={event=>change(task.key,{[field]:event.target.value})}/>}</div>;
        })}

        <details className="publication-options" open={invalidKey===task.key?true:undefined}><summary>更多设置</summary>
        <div className="field-label"><label htmlFor={task.key+'-capabilities'}>所需能力<RequiredMark/></label><HelpTip label={`任务 ${index+1} 所需能力说明`}>例如 writing、coding、testing，多个能力用英文逗号分隔。能力不代表执行授权。</HelpTip></div>
        <input id={task.key+'-capabilities'} aria-label={`任务 ${index+1} 所需能力`} value={task.capabilities} maxLength={409} required onChange={event=>change(task.key,{capabilities:event.target.value})}/>
        <label htmlFor={task.key+'-priority'}>优先级<RequiredMark/></label><select aria-label={`任务 ${index+1} 优先级`} id={task.key+'-priority'} required value={task.priority}
          onChange={event=>{const value=event.target.value;if(value==='low'||value==='normal'||value==='high')change(task.key,{priority:value});}}>
          <option value="low">低</option><option value="normal">普通</option><option value="high">高</option></select>
        {tasks.length>1&&<div className="publication-dependencies"><p className="field-hint">依赖任务</p>{tasks.map((candidate,other)=>candidate.key!==task.key&&<label key={candidate.key} className="publication-check">
          <input type="checkbox" aria-label={`任务 ${index+1} 依赖任务 ${other+1}`} checked={task.dependsOn.includes(candidate.key)}
            onChange={event=>change(task.key,{dependsOn:event.target.checked?[...task.dependsOn,candidate.key]:task.dependsOn.filter(key=>key!==candidate.key)})}/>
          任务 {other+1}：{candidate.title||'未命名'}</label>)}</div>}
        </details>
        <button type="button" className="text-button publication-remove" disabled={tasks.length===1} onClick={()=>{
          setTasks(current=>current.filter(item=>item.key!==task.key).map(item=>({...item,dependsOn:item.dependsOn.filter(key=>key!==task.key)})));setConfirmed(false);
        }}>移除任务 {index+1}</button>
      </fieldset></details>)}

      {stage==='review'&&<label className="publication-check"><input type="checkbox" aria-required="true" disabled={locked||conflict} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我已确认故事版本和任务拆分<RequiredMark/></label>}
      <div className="form-actions"><button className="primary-button" type="submit" disabled={busy||conflict||(stage==='review'&&!confirmed&&!uncertain)||!history}>{uncertain?'重试确认结果':busy?'提交中…':stage==='draft'?'完成拆分':'确认发布任务'}</button><button className="secondary-button" type="button" disabled={locked||tasks.length>=20} onClick={()=>{let key:string;do{key='task'+nextKey.current++;}while(tasks.some(task=>task.key===key));setTasks(current=>[...current,blank(key)]);setEditingKey(key);setConfirmed(false);}}><Plus size={15} aria-hidden="true"/>添加任务</button></div>
    </form>}
    <details className="publication-history" open={history===null?true:undefined}><summary>发布记录{history&&` · ${history.publications.length}`}</summary><button type="button" className="secondary-button" disabled={busy||uncertain} onClick={()=>void load()}>刷新发布记录</button>
      {history===null?<p className="field-hint">{busy?'正在读取发布记录…':'发布记录未加载。'}</p>:<ul className="revision-list">{history.publications.map(item=><li key={item.id}>
        <button type="button" className="text-button" disabled={busy} onClick={()=>void view(item.id)}>查看版本 {item.storyVersion} 的发布</button><span> · {item.taskCount} 项任务</span>
      </li>)}</ul>}
      {history?.publications.length===0&&<p className="field-hint">尚未发布任务。</p>}
      {history?.hasMore&&<p className="field-hint">仅显示最近 50 次发布，较早记录未在此列出。</p>}
    </details>
    {result&&<section aria-label="发布结果"><p className="notice notice-success" role="status">已发布 {result.tasks.length} 项任务。打开任务可查看最新分配与执行进度。</p>
      <ol className="revision-list publication-result-list">{result.tasks.map(task=><li key={task.id}>
        <div className="section-heading"><button type="button" className="text-button" aria-label={'查看任务：'+task.title} onClick={()=>onExecution(task.id)}>{task.title||'TASK-'+task.id.slice(0,6).toUpperCase()}</button><span className={'role-label task-state '+task.status}>{taskStatusLabel[task.status]}</span></div>
        <p>{task.objective}</p><details><summary>发布内容</summary><p>验收：{task.acceptanceCriteria}</p><p>能力：{task.requiredCapabilities.join('、')}</p><p>依赖：{task.dependsOn.map(id=>result.tasks.find(item=>item.id===id)?.title??id).join('、')||'无'}</p></details>
      </li>)}</ol>
      <details className="publication-source"><summary>发布时的故事原文 · 版本 {result.storyVersion}</summary><h4>{result.sourceStory.title}</h4><BodyContent body={result.sourceStory.body} projectId={projectId}/></details>
    </section>}
  </section>;
}
import BodyContent from './BodyContent';
