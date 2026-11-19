import RequiredMark from './RequiredMark';
import HelpTip from './HelpTip';
import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import ExecutionRecovery from './ExecutionRecovery';
import AddAgent from './AddAgent';
import AgentModel from './AgentModel';
import AgentCredentialSelect from './AgentCredentialSelect';
import {modelChoiceSchema,modelRoutingDefaults} from '../../packages/domain/agent-models';
import {Plus,Pencil,Save,Trash2,X,ChevronRight,Monitor} from 'lucide-react';
import {AgentStatus,AgentMetadata,AgentReadinessChecks,agentReadinessSchema} from './AgentSummary';
import {usePageState} from './page-state';
import {ConfirmDialog} from './Modal';
import './agents.css';

const grant=z.object({projectId:z.uuid(),enabled:z.boolean(),version:z.number().int().positive()}).strict();
const agent=z.object({id:z.uuid(),name:z.string(),instructions:z.string(),model:modelChoiceSchema,effectiveModel:z.string().nullable(),runnerId:z.uuid(),deviceName:z.string(),profile:z.enum(['demo','dsh-text','codex-code']),credentialId:z.string().nullable(),credentialLabel:z.string().nullable(),credentialKind:z.enum(['subscription','api-key']).nullable(),enabled:z.boolean(),version:z.number().int().positive(),maxConcurrency:z.literal(1),revoked:z.boolean(),runnerConnected:z.boolean(),executorReady:z.boolean(),modelReady:z.boolean(),available:z.boolean(),readiness:agentReadinessSchema,projectGrants:z.array(grant)}).strict();
export const agentListingSchema=z.object({identityId:z.string(),agents:z.array(agent)}).strict();
const policy=z.object({identityId:z.string(),settings:z.object({maxConcurrency:z.number().int().min(1).max(8),version:z.number().int().min(0)}).strict()}).strict();
const receipt=z.object({identityId:z.string(),version:z.number().int().positive()}).strict();
const savedReceipt=z.object({identityId:z.string(),saved:z.literal(true)}).strict();
const deletedReceipt=z.object({identityId:z.string(),deleted:z.literal(true)}).strict();
const routingAgent=z.object({id:z.uuid(),difficultyMin:z.number().int().min(1).max(5),difficultyMax:z.number().int().min(1).max(5),preference:z.enum(['quality','balanced','economy']),relativeCost:z.number().int().min(1).max(3),version:z.number().int().positive(),history:z.object({accepted:z.number().int().nonnegative(),rejected:z.number().int().nonnegative()}).strict(),lastDecision:z.object({score:z.number(),explanation:z.record(z.string(),z.unknown()),createdAt:z.string()}).strict().nullable()}).strict();
const routingListing=z.object({identityId:z.string(),agents:z.array(routingAgent)}).strict();
type Change={path:string;body:object};
type AgentDraft={enabled:boolean;model:string|null;credentialId?:string;version:number};
type RoutingDraft=z.infer<typeof routingAgent>;
function decisionWeight(value:RoutingDraft['lastDecision'],key:'quality'|'cost'){
  const weights=value?.explanation.weights;
  return weights&&typeof weights==='object'&&key in weights?String((weights as Record<string,unknown>)[key]):'—';
}

export default function Agents({identityId,projectId,onBack,onManageDevices,resumeId,onReturnHandled,onGrantChanged}:{identityId:string;projectId?:string;onBack:()=>void;onManageDevices?:()=>void;resumeId?:string|null;onReturnHandled?:()=>void;onGrantChanged?:()=>void}){
  const [adding,setAdding]=usePageState('agents.'+(projectId??'personal')+'.adding',z.boolean(),!!resumeId);
  const [createVisible,setCreateVisible]=useState(adding||!!resumeId);
  const [createBusy,setCreateBusy]=useState(false);
  useEffect(()=>{if(resumeId){setAdding(true);setCreateVisible(true);}},[resumeId]);
  const canConfigure=!projectId,canAdd=!projectId&&!!onManageDevices;
  const capacityId=useId();
  const [agents,setAgents]=useState<z.infer<typeof agent>[]|null>(null),[settings,setSettings]=useState<z.infer<typeof policy>['settings']|null>(null);
  const scope='agents.'+(projectId??'personal');
  const [capacityDraft,setCapacityDraft]=usePageState(scope+'.capacity',z.object({value:z.number().int().min(1).max(8),version:z.number().int().nonnegative()}).nullable(),null),[drafts,setDrafts]=usePageState<Record<string,AgentDraft>>(scope+'.settings',z.record(z.string(),z.object({enabled:z.boolean(),model:modelChoiceSchema,credentialId:z.string().optional(),version:z.number().int().positive()})),{});
  const [routing,setRouting]=useState<Record<string,z.infer<typeof routingAgent>>>({}),[routingDrafts,setRoutingDrafts]=usePageState<Record<string,RoutingDraft>>(scope+'.routing',z.record(z.string(),routingAgent),{});
  const [selectedId,setSelectedId]=usePageState(scope+'.selected',z.string().nullable(),null);
  const [editing,setEditing]=useState(false),[pendingSelection,setPendingSelection]=useState<{id:string|null}|null>(null);
  const detailHeading=useRef<HTMLHeadingElement>(null);
  const detailBody=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(selectedId)detailHeading.current?.focus();},[selectedId]);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState<string|null>(null),[removing,setRemoving]=useState<z.infer<typeof agent>|null>(null);
  const alive=useRef(false),operation=useRef(0),controller=useRef<AbortController|null>(null),working=useRef(false);
  const path=projectId?'/projects/'+projectId+'/agent-grants':'/agents';
  const stale=!!agents&&!!settings&&(
    !!capacityDraft&&capacityDraft.version!==settings.version||
    Object.entries(drafts).some(([id,draft])=>agents.find(resource=>resource.id===id)?.version!==draft.version)||
    Object.entries(routingDrafts).some(([id,draft])=>routing[id]?.version!==draft.version));
  const load=useCallback(async()=>{
    const generation=++operation.current;controller.current?.abort();const current=new AbortController();controller.current=current;
    const [resources,limits,routes]=await Promise.all([accountRequest(path,agentListingSchema,{signal:current.signal}),accountRequest('/execution-settings',policy,{signal:current.signal}),accountRequest('/agent-routing',routingListing,{signal:current.signal})]);
    if(!alive.current||current.signal.aborted||generation!==operation.current)return;
    if(resources.identityId!==identityId||limits.identityId!==identityId||routes.identityId!==identityId)throw new AccountRequestError(403);
    setAgents(resources.agents);setSettings(limits.settings);setRouting(Object.fromEntries(routes.agents.map(value=>[value.id,value])));
  },[path,identityId]);
  function failed(error:unknown){
    if(!alive.current)return;setAgents(null);setSettings(null);
    setNotice(denied(error)?'账号已变化或无权访问，请返回后重新登录。':'状态读取失败，请刷新网页。');
  }
  useEffect(()=>{
    alive.current=true;void load().catch(error=>{if(!(error instanceof DOMException&&error.name==='AbortError'))failed(error);});
    const refresh=()=>{if(!working.current&&document.visibilityState==='visible')void load().catch(error=>{if(!(error instanceof DOMException&&error.name==='AbortError'))failed(error);});};
    const timer=window.setInterval(refresh,10_000);window.addEventListener('focus',refresh);
    return()=>{alive.current=false;++operation.current;controller.current?.abort();window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[load]);
  useEffect(()=>{
    const restore=()=>{if(window.location.hash==='#agents')setCreateVisible(false);else if(window.location.hash.startsWith('#agent-create=')){setAdding(true);setCreateVisible(true);}};
    window.addEventListener('popstate',restore);window.addEventListener('hashchange',restore);
    return()=>{window.removeEventListener('popstate',restore);window.removeEventListener('hashchange',restore);};
  },[setAdding]);
  async function apply(command:Change){
    if(working.current)return false;working.current=true;setBusy(true);setNotice(null);
    ++operation.current;controller.current?.abort();
    try{
      const result=await accountRequest(command.path,z.union([receipt,savedReceipt]),{body:{identityId,...command.body}});
      if(!alive.current)return;
      if(result.identityId!==identityId)throw new AccountRequestError(403);
      try{await load();}catch(error){failed(error);if(alive.current&&!denied(error))setNotice('设置已提交，但状态读取失败，请刷新网页。');}
      if(projectId)onGrantChanged?.();
      return true;
    }catch(error){if(alive.current){
      if(denied(error)){failed(error);}
      else if(error instanceof AccountRequestError&&error.status===409){try{await load();}catch{setAgents(null);setSettings(null);}setNotice('设置已被更新，请刷新网页后核对。');}
      else setNotice('操作结果尚未确认，请重试或刷新网页查看。');
    }}finally{working.current=false;if(alive.current)setBusy(false);}
    return false;
  }
  async function remove(resource:z.infer<typeof agent>){
    if(working.current)return;
    working.current=true;setBusy(true);setNotice(null);
    try{
      const result=await accountRequest('/agents/'+resource.id,deletedReceipt,{method:'DELETE',body:{identityId}});
      if(!alive.current)return;
      if(result.identityId!==identityId)throw new AccountRequestError(403);
      await load();discard(resource.id);setSelectedId(null);setEditing(false);setRemoving(null);
    }catch(error){if(alive.current){if(denied(error))failed(error);else if(error instanceof AccountRequestError&&error.status===409)setNotice('该 Agent 正在执行任务或担任项目协调 Agent，请先处理相关任务后再删除。');else setNotice('删除结果尚未确认，请刷新网页查看。');}}
    finally{working.current=false;if(alive.current)setBusy(false);}
  }
  function edit(resource:z.infer<typeof agent>,change:Partial<AgentDraft>){setDrafts(current=>{
    const next={...current},draft={...(current[resource.id]??{enabled:resource.enabled,model:resource.model,version:resource.version}),...change};
    if(draft.enabled===resource.enabled&&draft.model===resource.model&&(draft.credentialId===undefined||draft.credentialId===resource.credentialId))delete next[resource.id];else next[resource.id]=draft;
    return next;
  });}
  function editRouting(id:string,change:Partial<RoutingDraft>){const original=routing[id];if(!original)return;
    setRoutingDrafts(current=>({...current,[id]:{...(current[id]??original),...change}}));
  }
  function discard(id:string){
    setDrafts(current=>{const next={...current};delete next[id];return next;});
    setRoutingDrafts(current=>{const next={...current};delete next[id];return next;});
  }
  function selectAgent(id:string|null){
    if(busy||id===selectedId)return;
    if(selectedId&&(drafts[selectedId]||routingDrafts[selectedId])){setPendingSelection({id});return;}
    finishSelection(id);
  }
  function finishSelection(id:string|null){
    const previous=selectedId;setSelectedId(id);setEditing(false);setNotice(null);
    if(!id&&previous)requestAnimationFrame(()=>document.getElementById('agent-row-'+previous)?.focus());
  }
  async function saveAll(id?:string){
    if(!agents||!settings||stale)return;
    const resource=agents.find(value=>value.id===id),draft=id?drafts[id]:undefined,route=id?routingDrafts[id]:undefined;
    if(draft?.credentialId!==undefined){
      const field=detailBody.current?.querySelector<HTMLSelectElement>('.agent-credential-select select');
      if(!field?.value){field?.reportValidity();return;}
    }
    const changes=resource&&(draft||route)?[{id:resource.id,expectedVersion:draft?.version??resource.version,enabled:draft?.enabled??resource.enabled,
      ...(draft&&draft.model!==resource.model?{model:draft.model}:{}),
      ...(draft?.credentialId!==undefined&&draft.credentialId!==resource.credentialId?{credentialId:draft.credentialId}:{}),
      ...(route?{routing:{expectedVersion:route.version,difficultyMin:route.difficultyMin,difficultyMax:route.difficultyMax,preference:route.preference,relativeCost:route.relativeCost}}:{}),
    }]:[];
    if(!changes.length&&(id||!capacityDraft)){setEditing(false);return;}
    const saved=await apply({path:'/agent-settings',body:{agents:changes,...(!id&&capacityDraft?{capacity:{maxConcurrency:capacityDraft.value,expectedVersion:capacityDraft.version}}:{})}});
    if(!saved)return;
    if(id){discard(id);setEditing(false);}else setCapacityDraft(null);
  }
  function closeCreation(){setAdding(false);setCreateVisible(false);onReturnHandled?.();window.history.replaceState(null,'',window.location.pathname+window.location.search+'#agents');}
  function openCreation(){setAdding(true);setCreateVisible(true);window.history.pushState(null,'',window.location.pathname+window.location.search+'#agent-create='+crypto.randomUUID());}
  function selectTab(creating:boolean){setCreateVisible(creating);if(!creating)window.history.pushState(null,'',window.location.pathname+window.location.search+'#agents');}
  const selected=canConfigure?agents?.find(resource=>resource.id===selectedId):undefined;
  const draft=selected?drafts[selected.id]:undefined;
  const route=selected?(editing?routingDrafts[selected.id]??routing[selected.id]:routing[selected.id]):undefined;
  const dirty=!!selected&&!!(draft||routingDrafts[selected.id]);
  return <section className="personal-agents-page" aria-label={projectId?'我的项目执行授权':'我的 Agent'}>
    <header className="workspace-page-heading"><div><h1>{projectId?'我的项目执行授权':'我的 Agent'}</h1>{agents&&<span>{agents.length} 个 Agent</span>}</div>{canAdd&&<button type="button" className="primary-button" aria-label="添加 Agent" disabled={busy||createVisible} onClick={openCreation}><Plus size={16}/>新增 Agent</button>}</header>
    {adding&&canAdd&&<div className="organization-tabs agent-page-tabs" role="tablist" aria-label="Agent 页面" onKeyDown={event=>{if(createBusy||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const creating=event.key==='Home'?false:event.key==='End'?true:!createVisible;selectTab(creating);document.getElementById(creating?'agent-create-tab':'agent-list-tab')?.focus();}}>
      <button type="button" role="tab" id="agent-list-tab" tabIndex={createVisible?-1:0} disabled={createBusy} aria-selected={!createVisible} aria-controls="agent-list-panel" onClick={()=>selectTab(false)}>Agent 列表</button>
      <button type="button" role="tab" id="agent-create-tab" tabIndex={createVisible?0:-1} disabled={createBusy} aria-selected={createVisible} aria-controls="agent-create-panel" onClick={()=>selectTab(true)}>新增 Agent</button>
      <button className="agent-tab-close" type="button" title="关闭新增 Agent" aria-label="关闭新增 Agent" disabled={createBusy} onClick={closeCreation}><X size={16}/></button>
    </div>}
    {adding&&canAdd&&createVisible?<div id="agent-create-panel" role="tabpanel" aria-labelledby="agent-create-tab"><AddAgent identityId={identityId} sources={agents??[]} resumeId={resumeId} onRefresh={load} onBusyChanged={setCreateBusy} onManageDevices={onManageDevices!} onCancel={closeCreation} onCreated={async()=>{closeCreation();try{await load();}catch(error){failed(error);setNotice('Agent 已创建，但列表读取失败，请刷新网页。');}}}/></div>:<div id="agent-list-panel" role={adding?'tabpanel':undefined} aria-labelledby={adding?'agent-list-tab':undefined}>
    {notice&&<div className="notice notice-error" role="alert">{notice}</div>}
    {stale&&<div className="notice notice-error" role="alert">设置已变化，旧草稿不能直接覆盖。<button type="button" className="text-button" disabled={busy} onClick={()=>{setDrafts({});setCapacityDraft(null);setRoutingDrafts({});setNotice(null);}}>放弃草稿，使用当前设置</button></div>}
    <div className={'personal-agents-layout'+(selected?' has-detail':'')}>
    <div className="personal-agents-inventory">
    {agents===null?<p role="status">资源状态尚未确认。</p>:agents.length===0?(!adding&&<p className="compact-empty">尚未发现 Agent</p>):canConfigure?
      <div className="personal-agent-list" aria-label="Agent 列表">
        <div className="personal-agent-list-heading"><span>Agent / 运行环境</span><span>状态</span></div>
        {agents.map(resource=><button key={resource.id} id={'agent-row-'+resource.id} type="button" className="personal-agent-row" aria-label={'查看 Agent：'+resource.name} aria-pressed={selectedId===resource.id} disabled={busy} onClick={()=>selectAgent(resource.id)}>
          <span className="personal-agent-identity"><strong>{resource.name}</strong><span className="personal-agent-model">{resource.profile==='codex-code'?'Codex':resource.profile==='dsh-text'?'DSH':'模拟执行器'} · {resource.model??resource.effectiveModel??'默认模型待确认'}</span><span className="personal-agent-device"><Monitor size={14} aria-hidden="true"/>{resource.deviceName}</span></span>
          <span className="personal-agent-row-status"><AgentStatus agent={resource}/>{(drafts[resource.id]||routingDrafts[resource.id])&&<span className="field-hint">未保存</span>}<ChevronRight size={16} aria-hidden="true"/></span>
        </button>)}
      </div>:
      <div className="agent-grid">{agents.map(resource=>{const projectGrant=resource.projectGrants.find(g=>g.projectId===projectId);return <article key={resource.id} className="agent-card" aria-label={resource.name}>
        <div className="agent-card-heading"><h4>{resource.name}</h4><AgentStatus agent={resource}/></div><AgentMetadata agent={resource}/><AgentReadinessChecks agent={resource}/>
        {resource.instructions&&<p className="agent-card-description">{resource.instructions}</p>}
        <p className="field-hint">{projectGrant?.enabled?'已授权此项目':'未授权此项目'}</p>
        <div className="form-actions"><p className="field-hint">{projectGrant?.enabled?'撤销后不再分配新任务；已有执行不会因此停止。':'授权后此项目可使用你的模型账号额度，可能产生费用；不影响其他项目。'}</p><button className="secondary-button" disabled={busy||(resource.revoked&&!projectGrant?.enabled)} onClick={()=>void apply({path,body:{agentId:resource.id,enabled:!projectGrant?.enabled,expectedVersion:projectGrant?.version??0}})}>{projectGrant?.enabled?'撤销此项目授权':'授权给此项目'}</button></div>
      </article>;})}</div>}
    {canConfigure&&settings&&<form className="personal-agent-capacity" onSubmit={event=>{event.preventDefault();void saveAll();}}>
      <div><div className="field-label"><label htmlFor={capacityId}>同时执行上限<RequiredMark/></label><HelpTip label="同时执行上限说明">所有电脑、Agent 和项目共享此上限。同一电脑目前同时执行一个任务。</HelpTip></div><p className="field-hint">所有 Agent 与项目共享</p></div>
      <select id={capacityId} required disabled={busy} value={capacityDraft?.value??settings.maxConcurrency} onChange={e=>{const value=Number(e.target.value);setCapacityDraft(value===settings.maxConcurrency?null:{value,version:capacityDraft?.version??settings.version});}}>{[1,2,3,4,5,6,7,8].map(n=><option key={n} value={n}>{n}</option>)}</select>
      {capacityDraft&&<><p className="field-hint">提高上限可能增加同时产生的费用；调低不会停止已有任务。</p><button type="submit" className="secondary-button" disabled={busy||!agents||stale}>保存执行上限</button></>}
    </form>}
    {!projectId&&<ExecutionRecovery identityId={identityId}/>}
    </div>
    {selected&&<section className="personal-agent-detail" aria-label={'Agent 详情：'+selected.name} onKeyDown={event=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){event.stopPropagation();selectAgent(null);}}}>
      <header className="personal-agent-detail-heading"><div><h2 ref={detailHeading} tabIndex={-1}>{selected.name}</h2><span className="field-hint">{editing?'编辑 Agent':'Agent 详情'}</span></div><div className="personal-agent-detail-actions">
        <button type="button" className={'agent-detail-icon'+(editing?' is-primary':'')} aria-label={editing?'保存 Agent':'编辑 Agent'} title={editing?'保存 Agent':'编辑 Agent'} disabled={busy||(editing&&stale)} onClick={()=>{if(editing)void saveAll(selected.id);else setEditing(true);}}>{editing?<Save size={18} aria-hidden="true"/>:<Pencil size={18} aria-hidden="true"/>}</button>
        <button type="button" className="agent-detail-icon" aria-label="关闭详情" title="关闭详情" disabled={busy} onClick={()=>selectAgent(null)}><X size={18} aria-hidden="true"/></button>
      </div></header>
      <div className="personal-agent-detail-body" ref={detailBody} aria-busy={busy}>
        {dirty&&!editing&&<p className="field-hint">有未保存的草稿，点击编辑可继续修改。</p>}
        <section className="agent-detail-section"><div className="agent-detail-section-heading"><h3>运行状态</h3>{editing?<label className="agent-detail-enabled"><input type="checkbox" checked={draft?.enabled??selected.enabled} disabled={busy||(selected.revoked&&!selected.enabled)} onChange={event=>edit(selected,{enabled:event.target.checked})}/>启用 Agent</label>:<AgentStatus agent={selected}/>}</div>
          <AgentReadinessChecks agent={selected}/>
          <dl className="agent-detail-values"><div><dt>Runner</dt><dd>{selected.deviceName}</dd></div><div><dt>执行器</dt><dd>{selected.profile==='codex-code'?'Codex':selected.profile==='dsh-text'?'DSH':'模拟执行器'}</dd></div></dl>
          {!selected.runnerConnected&&onManageDevices&&<button type="button" className="text-button" disabled={busy} onClick={onManageDevices}>管理 Runner</button>}
          {editing&&draft&&draft.enabled!==selected.enabled&&<p className="field-hint">{draft.enabled?'启用后，已授权项目可使用这个 Agent 和你的模型账号额度，可能产生费用；不会自动授权其他项目。':'停用后将不再领取新任务；这不证明已有本地执行已停止。'}</p>}
        </section>
        <section className="agent-detail-section"><h3>模型与账号</h3>
          {editing?<><AgentModel identityId={identityId} profile={selected.profile} value={draft?draft.model:selected.model} disabled={busy||selected.revoked} onChange={(model,entry)=>{edit(selected,{model});const defaults=entry?{difficultyMin:entry.difficultyMin,difficultyMax:entry.difficultyMax,relativeCost:entry.relativeCost}:modelRoutingDefaults(model??selected.effectiveModel);if(routing[selected.id])editRouting(selected.id,defaults);}}/>
            {selected.profile!=='demo'&&<AgentCredentialSelect identityId={identityId} runnerId={selected.runnerId} profile={selected.profile} value={draft?.credentialId??selected.credentialId??''} disabled={busy||selected.revoked} onChange={credentialId=>edit(selected,{credentialId})} onRefresh={load}/>}
            {draft&&draft.model!==selected.model&&<p className="field-hint">切换模型只影响后续分配的任务，不改变在途任务。不同模型可能有不同费用。</p>}
          </>:<dl className="agent-detail-values"><div><dt>模型</dt><dd>{selected.model??selected.effectiveModel??'默认模型待确认'}</dd></div><div><dt>使用账号</dt><dd>{selected.credentialLabel?`${selected.credentialKind==='subscription'?'订阅':'API Key'} · ${selected.credentialLabel}`:'尚未配置'}</dd></div></dl>}
        </section>
        {route&&<section className="agent-detail-section"><div className="agent-detail-section-heading"><h3>任务分配</h3><HelpTip label="路由依据说明">先检查授权、在线、容量、能力和难度；再参考最近 {route.history.accepted+route.history.rejected} 次人工验收结果（接受 {route.history.accepted}，拒绝 {route.history.rejected}）与相对资源成本。少量记录会保守处理。{route.lastDecision&&<> 最近分配：质量权重 {decisionWeight(route.lastDecision,'quality')}，资源成本权重 {decisionWeight(route.lastDecision,'cost')}。</>}</HelpTip></div>
          {editing?<div className="agent-detail-fields"><label>最低难度<RequiredMark/><select required value={route.difficultyMin} disabled={busy} onChange={event=>editRouting(selected.id,{difficultyMin:Math.min(Number(event.target.value),route.difficultyMax)})}>{[1,2,3,4,5].map(value=><option key={value}>{value}</option>)}</select></label><label>最高难度<RequiredMark/><select required value={route.difficultyMax} disabled={busy} onChange={event=>editRouting(selected.id,{difficultyMax:Math.max(Number(event.target.value),route.difficultyMin)})}>{[1,2,3,4,5].map(value=><option key={value}>{value}</option>)}</select></label>
            <label>分配偏好<RequiredMark/><select required value={route.preference} disabled={busy} onChange={event=>editRouting(selected.id,{preference:event.target.value as RoutingDraft['preference']})}><option value="quality">质量优先</option><option value="balanced">均衡</option><option value="economy">节约优先</option></select></label><label>相对资源成本<RequiredMark/><select required value={route.relativeCost} disabled={busy} onChange={event=>editRouting(selected.id,{relativeCost:Number(event.target.value)})}><option value="1">低</option><option value="2">中</option><option value="3">高</option></select></label>
          </div>:<dl className="agent-detail-values"><div><dt>任务难度</dt><dd>{route.difficultyMin}–{route.difficultyMax}</dd></div><div><dt>分配偏好</dt><dd>{{quality:'质量优先',balanced:'均衡',economy:'节约优先'}[route.preference]}</dd></div><div><dt>相对资源成本</dt><dd>{['低','中','高'][route.relativeCost-1]}</dd></div></dl>}
        </section>}
        {selected.instructions&&<section className="agent-detail-section"><h3>执行说明</h3><p className="agent-detail-instructions">{selected.instructions}</p></section>}
      </div>
      <footer className="personal-agent-detail-footer">{editing?<><span role="status" className="field-hint">{busy?'保存中…':dirty?'有未保存的修改':'编辑中'}</span><button type="button" className="text-button" disabled={busy} onClick={()=>{discard(selected.id);setEditing(false);setNotice(null);}}>取消修改</button></>:<button type="button" className="agent-detail-delete" disabled={busy} onClick={()=>setRemoving(selected)}><Trash2 size={14} aria-hidden="true"/>删除 Agent</button>}</footer>
    </section>}
    </div>
    </div>}
    {pendingSelection&&<ConfirmDialog title="放弃未保存的修改？" description="离开此 Agent 将放弃本次修改。" confirmLabel="放弃修改" onConfirm={()=>{if(selectedId)discard(selectedId);finishSelection(pendingSelection.id);setPendingSelection(null);}} onClose={()=>setPendingSelection(null)}/>}
    {removing&&<ConfirmDialog title="删除 Agent" description={<>确定删除 Agent <strong>“{removing.name}”</strong>？删除后将从列表和项目授权中移除，历史执行记录仍会保留。</>} confirmLabel="删除 Agent" danger busy={busy} onConfirm={()=>void remove(removing)} onClose={()=>{if(!busy)setRemoving(null);}}/>}
  </section>;
}
