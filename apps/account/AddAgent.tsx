import RequiredMark from './RequiredMark';
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import HelpTip from './HelpTip';
import AgentCredentialSelect from './AgentCredentialSelect';
import AgentModel from './AgentModel';
import {deviceListingSchema} from './Devices';
import {readAgentReturn,saveAgentReturn,clearAgentReturn,agentDraftSchema,type AgentDraft} from './agent-return';
import {usePageState} from './page-state';

const profileSchema=z.enum(['demo','dsh-text','codex-code']);
type Profile=z.infer<typeof profileSchema>;
type Source={id:string;runnerId:string;deviceName:string;profile:Profile;revoked:boolean;available:boolean};
const receipt=z.object({identityId:z.string(),agentId:z.uuid()}).strict();
export default function AddAgent({identityId,sources,onCreated,onCancel,onRefresh,onManageDevices,resumeId,onBusyChanged}:{identityId:string;sources:Source[];onCreated:()=>Promise<void>;onCancel:()=>void;onRefresh:()=>Promise<void>;onManageDevices:()=>void;resumeId?:string|null;onBusyChanged?:(busy:boolean)=>void}){
  const formId=useId();
  const draftScope='agents.create';
  const [cachedIntent,setCachedIntent]=usePageState(draftScope+'.intent',z.uuid().nullable(),null);
  const [cachedDraft,setCachedDraft]=usePageState(draftScope+'.draft',agentDraftSchema.nullable(),null);
  const [restored]=useState(()=>((!resumeId||resumeId===cachedIntent)?cachedDraft:null)??(resumeId||cachedIntent?readAgentReturn(identityId,(resumeId??cachedIntent)!):null));
  const returnIntent=useRef<string|null>(resumeId??cachedIntent??crypto.randomUUID());
  const [model,setModel]=useState<string|null>(restored?.model??null);
  const [name,setName]=useState(restored?.name??''),[instructions,setInstructions]=useState(restored?.instructions??''),[runnerId,setRunnerId]=useState(restored?.runnerId??''),[profile,setProfile]=useState<Profile>(restored?.profile??'dsh-text'),[credentialId,setCredentialId]=useState(restored?.credentialId??'');
  const [devices,setDevices]=useState<z.infer<typeof deviceListingSchema>['devices']|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[deviceNotice,setDeviceNotice]=useState('');
  const pending=useRef<AgentDraft['pending']>(restored?.pending??null),working=useRef(false),alive=useRef(false),generation=useRef(0),controller=useRef<AbortController|null>(null);
  function saveReturn(intentId:string){returnIntent.current=intentId;const draft={name,instructions,runnerId,profile,model,credentialId,pending:pending.current};setCachedIntent(intentId);setCachedDraft(draft);saveAgentReturn(identityId,intentId,draft);}
  function clearReturn(){if(returnIntent.current)clearAgentReturn(identityId,returnIntent.current);returnIntent.current=null;setCachedIntent(null);setCachedDraft(null);window.history.replaceState(null,'',window.location.pathname+window.location.search+'#agents');}
  useEffect(()=>{if(resumeId)returnIntent.current=resumeId;},[resumeId]);
  useEffect(()=>{if(returnIntent.current)window.history.replaceState(null,'',window.location.pathname+window.location.search+'#agent-create='+returnIntent.current);},[]);
  useEffect(()=>{if(returnIntent.current)saveReturn(returnIntent.current);},[name,instructions,runnerId,profile,model,credentialId]);
  const load=useCallback(async(confirmedRunner?:string)=>{
    const op=++generation.current;controller.current?.abort();const active=new AbortController();controller.current=active;
    try{
      const result=await accountRequest('/devices',deviceListingSchema,{signal:active.signal});
      if(!alive.current||active.signal.aborted||op!==generation.current)return;
      if(result.identityId!==identityId)throw new AccountRequestError(403);
      setDevices(result.devices);setDeviceNotice('');
      const activeDevices=result.devices.filter(d=>!d.revoked&&d.online);
      setRunnerId(current=>confirmedRunner&&activeDevices.some(d=>d.runnerId===confirmedRunner)?confirmedRunner:current||(activeDevices.length===1?activeDevices[0].runnerId:''));
    }catch(error){if(alive.current&&!active.signal.aborted&&op===generation.current){setDevices(null);setDeviceNotice(denied(error)?'账号已变化，请重新登录。':'Runner 列表暂时无法读取。');}}
  },[identityId]);
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;++generation.current;controller.current?.abort();};},[load]);
  useEffect(()=>{const refresh=()=>{if(!working.current)void load();};const timer=window.setInterval(refresh,10_000);window.addEventListener('focus',refresh);return()=>{window.clearInterval(timer);window.removeEventListener('focus',refresh);};},[load]);
  const choices=devices?.filter(d=>!d.revoked&&d.online)??[],selected=choices.find(d=>d.runnerId===runnerId);
  const source=sources.find(a=>!a.revoked&&a.runnerId===runnerId&&a.profile===profile);
  const demo=sources.some(a=>!a.revoked&&a.runnerId===runnerId&&a.profile==='demo');
  const valid=!!selected&&(profile==='demo'&&demo||((profile==='dsh-text'||profile==='codex-code')&&!!credentialId));
  async function submit(event:FormEvent){
    event.preventDefault();if(working.current||!name.trim()||!valid)return;
    const values={name:name.trim(),instructions:instructions.trim(),model,...(profile==='demo'?{}:{credentialId})},key=JSON.stringify({runnerId,profile,...values});
    if(pending.current?.key!==key)pending.current={key,requestId:crypto.randomUUID(),input:{...values,...(source?{sourceAgentId:source.id}:{runnerId,profile})}};
    if(returnIntent.current)saveReturn(returnIntent.current);
    working.current=true;setBusy(true);onBusyChanged?.(true);setNotice('');
    try{
      const result=await accountRequest('/agents',receipt,{body:{identityId,...pending.current.input,requestId:pending.current.requestId}});
      if(!alive.current)return;if(result.identityId!==identityId)throw new AccountRequestError(403);
      pending.current=null;clearReturn();await onCreated();
    }catch(error){if(alive.current)setNotice(denied(error)?'账号或电脑授权已变化，请重新进入 Agent 管理。':'创建结果尚未确认，可重试；不会重复创建。');}
    finally{working.current=false;if(alive.current)setBusy(false);onBusyChanged?.(false);}
  }
  function leave(){if(busy)return;if(returnIntent.current)saveReturn(returnIntent.current);window.history.replaceState(null,'',window.location.pathname+window.location.search+'#agents');onCancel();}
  function configureRunner(){if(returnIntent.current)saveReturn(returnIntent.current);onManageDevices();}
  return <section className="agent-create" aria-label="添加 Agent">
    <div className="section-heading"><h4>添加 Agent</h4><button type="button" className="text-button" disabled={busy} onClick={leave}>取消添加</button></div>
    {notice&&<p className="notice notice-error" role="alert">{notice}</p>}
    {deviceNotice&&<p className="notice notice-error" role="alert">{deviceNotice}</p>}
    <form className="story-form" aria-label="创建 Agent" onSubmit={submit} aria-busy={busy}>
      <fieldset className="agent-create-group"><legend>运行环境</legend>
      <div className="agent-create-grid"><div className="agent-create-field">
      <div className="field-label"><label htmlFor={formId+'-computer'}>Runner<RequiredMark/></label></div>
      <select id={formId+'-computer'} required disabled={busy||!choices.length} value={selected?runnerId:''} onChange={e=>{setRunnerId(e.target.value);setProfile('dsh-text');setModel(null);setCredentialId('');}}><option value="">{deviceNotice?'Runner 列表读取失败':devices===null?'正在读取 Runner…':choices.length?'选择 Runner':'暂无可用 Runner'}</option>{choices.map(d=><option key={d.runnerId} value={d.runnerId}>{d.name}</option>)}</select>
      </div><div className="agent-create-field">
      <div className="field-label"><label htmlFor={formId+'-type'}>Agent 类型<RequiredMark/></label></div>
      <select id={formId+'-type'} required disabled={busy} value={profile} onChange={e=>{setProfile(profileSchema.parse(e.target.value));setModel(null);setCredentialId('');}}><option value="dsh-text">DSH (DeepSeek)</option><option value="codex-code">Codex (OpenAI)</option><option value="claude" disabled>Claude Code · 未接入</option>{demo&&<option value="demo">模拟文本执行器</option>}</select>
      </div></div>
      {devices!==null&&(!choices.length||runnerId&&!selected)&&<div className="runner-required"><p>暂无可用 Runner</p><button type="button" className="secondary-button" disabled={busy} onClick={configureRunner}>配置runner</button></div>}
      {deviceNotice&&<button type="button" className="text-button" disabled={busy} onClick={()=>void load()}>重试</button>}
      <div className="agent-readiness"><span className="role-label" data-state={source?.available?'positive':'neutral'}>{source?.available?'执行已就绪':'执行未就绪'}</span><HelpTip label="账号状态说明">Codex 可使用本机订阅账号或 API Key；DSH 使用 API Key。凭据只留在所选电脑。创建后仍需启用 Agent 并授权项目。需要修改代码的任务还需在 Runner 上绑定项目代码仓库。</HelpTip></div>
      {profile!=='demo'&&<AgentCredentialSelect key={runnerId+':'+profile} identityId={identityId} runnerId={runnerId} profile={profile} value={credentialId} onChange={setCredentialId} disabled={busy||!selected} onRefresh={onRefresh}/>}
      <AgentModel identityId={identityId} profile={profile} value={model} onChange={setModel} disabled={busy}/>
      </fieldset>
      <fieldset className="agent-create-group"><legend>Agent 信息</legend>
      <div className="field-label"><label htmlFor={formId+'-name'}>Agent 名称<RequiredMark/></label></div><input id={formId+'-name'} required maxLength={120} disabled={busy} value={name} onChange={e=>setName(e.target.value)} placeholder="例如：文档助手"/>
      <div className="field-label"><label htmlFor={formId+'-instructions'}>职责说明</label><span className="field-optional">选填</span></div><textarea id={formId+'-instructions'} maxLength={4000} disabled={busy} value={instructions} onChange={e=>setInstructions(e.target.value)} placeholder="例如：整理文档，结果使用中文"/>
      </fieldset>
      <div className="form-actions"><button className="primary-button" disabled={busy||!valid||!name.trim()}>{busy?'创建中…':'创建 Agent'}</button></div>
    </form>
  </section>;
}
