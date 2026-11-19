import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {projectRole} from './hierarchy';
import {usePageState} from './page-state';
import Execution from './Execution';
import {AgentStatus,AgentMetadata,AgentReadinessChecks,agentReadinessSchema} from './AgentSummary';

const listing=z.object({identityId:z.string(),projectId:z.uuid(),ownerName:z.string(),agents:z.array(z.object({id:z.uuid(),name:z.string(),profile:z.string(),model:z.string().nullable(),effectiveModel:z.string().nullable(),deviceName:z.string(),enabled:z.boolean(),revoked:z.boolean(),runnerConnected:z.boolean(),executorReady:z.boolean(),modelReady:z.boolean(),available:z.boolean(),readiness:agentReadinessSchema}).strict())}).strict();
const coordinatorSchema=z.object({identityId:z.string(),coordinator:z.object({agentId:z.uuid().nullable(),version:z.number().int().nonnegative(),available:z.boolean(),paused:z.boolean(),pauseReason:z.string().nullable()}).strict()}).strict();
const receipt=z.object({identityId:z.string(),ok:z.literal(true)}).strict();

export default function ProjectAgents({identityId,project,boardId,onTab}:{identityId:string;project:{id:string;role:z.infer<typeof projectRole>};boardId:string;onTab:(tab:'agents'|'records')=>void}){
  const [tab,setTab]=usePageState('project.'+project.id+'.coordinator-tab',z.enum(['agents','records']),'agents');
  const [data,setData]=useState<z.infer<typeof listing>|null>(null),[coordinator,setCoordinator]=useState<z.infer<typeof coordinatorSchema>['coordinator']|null>(null);
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reading,setReading]=useState(true);
  const [draft,setDraft]=useState<{agentId:string;version:number}|null>(null);
  const selection=draft?.agentId??coordinator?.agentId??null;
  const alive=useRef(false),working=useRef(false),generation=useRef(0),controller=useRef<AbortController|null>(null);
  const path='/projects/'+project.id+'/coordinator',owner=project.role==='owner';
  const load=useCallback(async(background=false)=>{
    const seq=++generation.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;if(!background)setReading(true);
    try{
      const [resources,state]=await Promise.all([accountRequest(path+'/agents',listing,{signal:abort.signal}),accountRequest(path,coordinatorSchema,{signal:abort.signal})]);
      if(!alive.current||abort.signal.aborted||seq!==generation.current)return;
      if(resources.identityId!==identityId||state.identityId!==identityId||resources.projectId!==project.id)throw new AccountRequestError(403);
      setData(resources);setCoordinator(state.coordinator);if(!background){setDraft(null);setNotice('');}
    }finally{if(alive.current&&seq===generation.current)setReading(false);}
  },[identityId,path,project.id]);
  function fail(error:unknown){if(!alive.current||error instanceof DOMException&&error.name==='AbortError')return;setData(null);setCoordinator(null);setNotice(denied(error)?'当前账号无权访问此项目。':'协调配置暂时无法读取，请重试。');}
  useEffect(()=>{
    alive.current=true;void load().catch(fail);
    const refresh=()=>{if(!working.current&&document.visibilityState==='visible')void load(true).catch(fail);};
    const timer=window.setInterval(refresh,10_000);window.addEventListener('focus',refresh);
    return()=>{alive.current=false;++generation.current;controller.current?.abort();window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[load]);
  async function save(resume=false){
    if(working.current||!coordinator)return;working.current=true;setBusy(true);setNotice('');++generation.current;controller.current?.abort();
    try{
      const result=resume?await accountRequest(path+'/resume',receipt,{body:{identityId,expectedVersion:coordinator.version}}):await accountRequest(path,coordinatorSchema,{body:{identityId,agentId:selection,expectedVersion:draft?.version??coordinator.version,authorize:true}});
      if(!alive.current)return;if(result.identityId!==identityId)throw new AccountRequestError(403);
      await load();if(alive.current)setNotice(resume?'项目协调已恢复。':'协调授权已保存。');
    }catch(error){if(alive.current){
      if(denied(error))fail(error);
      else {try{await load();}catch(readError){fail(readError);return;}setNotice(error instanceof AccountRequestError&&error.status===409?'协调配置已变化，请核对后重新选择。':'操作结果尚未确认，已重新读取当前配置，请核对。');}
    }}finally{working.current=false;if(alive.current)setBusy(false);}
  }
  function changeTab(value:'agents'|'records'){setTab(value);onTab(value);}
  return <section className="project-coordinator" aria-label="项目协调Agent">
    <header className="workspace-page-heading"><div><h1>项目协调Agent</h1>{data&&<span>项目创建者：{data.ownerName}</span>}</div></header>
    <div className="organization-tabs" role="tablist" aria-label="项目协调分类">
      {(['agents','records'] as const).map(value=><button key={value} id={'coordinator-tab-'+value} type="button" role="tab" aria-selected={tab===value} aria-controls={'coordinator-panel-'+value} tabIndex={tab===value?0:-1} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'agents':event.key==='End'?'records':tab==='agents'?'records':'agents';changeTab(next);document.getElementById('coordinator-tab-'+next)?.focus();}}} onClick={()=>changeTab(value)}>{value==='agents'?'授权配置':'执行记录'}</button>)}
    </div>
    {tab==='records'?<div role="tabpanel" id="coordinator-panel-records" aria-labelledby="coordinator-tab-records"><Execution identityId={identityId} project={project} boardId={boardId} embedded onBack={()=>changeTab('agents')}/></div>:<div role="tabpanel" id="coordinator-panel-agents" aria-labelledby="coordinator-tab-agents">
      {notice&&<p role="status" className="notice">{notice}</p>}
      {reading&&<p role="status">正在读取协调配置…</p>}
      {!data&&!reading&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>{setReading(true);setNotice('');void load(true).catch(fail);}}>重新加载协调配置</button>}
      {coordinator&&(!coordinator.agentId||coordinator.paused)&&<p className="field-hint">{coordinator.paused?'项目协调已暂停':'尚未授权协调 Agent'}</p>}
      {coordinator?.paused&&<div className="notice notice-error"><p>{coordinator.pauseReason}</p>{owner&&<button className="secondary-button" disabled={busy||reading} onClick={()=>void save(true)}>{busy?'处理中…':'恢复项目协调'}</button>}</div>}
      {data&&coordinator&&<form aria-busy={busy} onSubmit={event=>{event.preventDefault();void save();}}>
        {draft&&draft.version!==coordinator.version&&<p role="status">协调配置已变化，请重新选择 Agent。</p>}
        <fieldset className="coordinator-options" disabled={!owner||busy||reading}><legend className="sr-only">协调 Agent</legend>
          <div className="agent-grid">{data.agents.map(agent=>{const unsupported=!['dsh-text','codex-code'].includes(agent.profile);return <label className="agent-card coordinator-card" key={agent.id}>
            <input type="radio" name="project-coordinator" value={agent.id} checked={selection===agent.id} disabled={!agent.enabled||agent.revoked||unsupported} onChange={()=>setDraft({agentId:agent.id,version:coordinator.version})} onClick={()=>setDraft({agentId:agent.id,version:coordinator.version})}/>
            <div className="agent-card-heading"><strong>{agent.name}</strong><AgentStatus agent={agent}/>{coordinator.agentId===agent.id&&<span className="agent-current-grant">当前授权</span>}</div>
            <AgentMetadata agent={agent}/>
            <AgentReadinessChecks agent={agent}/>
            {unsupported&&<small>不支持项目协调</small>}
          </label>;})}</div>
        </fieldset>
        {!data.agents.length&&<p className="compact-empty">项目创建者尚无 Agent</p>}
        {owner?<div className="form-actions"><button className="primary-button" disabled={busy||reading||!selection||selection===coordinator.agentId||!!draft&&draft.version!==coordinator.version||!data.agents.some(a=>a.id===selection&&a.enabled&&!a.revoked&&['dsh-text','codex-code'].includes(a.profile))}>{busy?'保存中…':'保存授权'}</button></div>:<p className="field-hint">由项目创建者管理协调授权</p>}
      </form>}
    </div>}
  </section>;
}
