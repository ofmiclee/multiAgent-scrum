import {useEffect,useMemo,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {defaultProjectEnv,projectConfigFields,mergeProjectConfigEnv,publicProjectConfig,ProjectConfigError,type ProjectConfigFields} from '../../packages/domain/project-files';
import './project-files.css';

const deviceSchema=z.object({runnerId:z.uuid(),name:z.string(),online:z.boolean(),revoked:z.boolean(),lastSeen:z.number().nullable(),executionReady:z.boolean()}).strict();
const viewSchema=z.object({
  version:z.number(),config:z.object({repositoryUrl:z.string(),branch:z.string(),deployEnvironment:z.string(),serverHost:z.string()}).strict().nullable(),canEdit:z.boolean(),
  personal:z.array(z.object({runnerId:z.uuid(),directory:z.string(),gitUsername:z.string(),hasGitToken:z.boolean(),deploymentAccess:z.boolean(),version:z.number()}).strict()),
  jobs:z.array(z.object({id:z.uuid(),runnerId:z.uuid(),version:z.number(),state:z.enum(['queued','running','ready','failed']),result:z.enum(['ok','local_changes','directory_exists','unsafe_path','git_failed','binding_failed','cancelled','unavailable']).nullable(),updatedAt:z.string()}).strict()),
}).strict();
const editorSchema=z.object({version:z.number(),agentsMd:z.string(),env:z.string()}).strict();
const actionSchema=z.object({ok:z.literal(true),version:z.number().optional()}).strict();
const devicesSchema=z.object({identityId:z.string(),devices:z.array(deviceSchema)}).strict();
const directoryPickStarted=z.object({id:z.uuid()}).strict();
const directoryPickStatus=z.object({id:z.uuid(),state:z.enum(['queued','running','selected','cancelled','unavailable','expired']),directory:z.string().nullable()}).strict();
type View=z.infer<typeof viewSchema>;
type ProjectFilesTab='config'|'personal';
const emptyEnv=defaultProjectEnv;
const emptyAgents='# Project instructions\n\nFollow the project test and review requirements before reporting completion.\n';

export default function ProjectFiles({projectId,tab,active=true}:{projectId:string;tab:ProjectFilesTab;active?:boolean}){
  const [view,setView]=useState<View|null>(null),[devices,setDevices]=useState<z.infer<typeof deviceSchema>[]>([]),[agents,setAgents]=useState(emptyAgents),[env,setEnv]=useState(emptyEnv),[runnerId,setRunnerId]=useState(''),[directory,setDirectory]=useState(''),[gitUsername,setGitUsername]=useState(''),[gitToken,setGitToken]=useState(''),[deploymentAccess,setDeploymentAccess]=useState(false),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[editorReady,setEditorReady]=useState(false),[pick,setPick]=useState<{id:string;runnerId:string}|null>(null);
  const refreshVersion=useRef(0),previousRunnerId=useRef(''),wasActive=useRef(active);
  const [fields,setFields]=useState(()=>projectConfigFields(emptyEnv)),[editorVersion,setEditorVersion]=useState(0);
  const [editing,setEditing]=useState(false),[personalEditing,setPersonalEditing]=useState(false);
  const editingRef=useRef(editing);editingRef.current=editing;
  const personalDraftRef=useRef(false);personalDraftRef.current=personalEditing||!view?.personal.some(item=>item.runnerId===runnerId);
  const [loadFailed,setLoadFailed]=useState(false),[accessDenied,setAccessDenied]=useState(false),[editorFailed,setEditorFailed]=useState(false),[loadRevision,setLoadRevision]=useState(0),[editorRevision,setEditorRevision]=useState(0);
  const personalEditButton=useRef<HTMLButtonElement>(null);
  const savedEditor=useRef<z.infer<typeof editorSchema>|null>(null),editButton=useRef<HTMLButtonElement>(null);
  const editedFields=useRef(new Set<keyof ProjectConfigFields>());
  const path='/projects/'+projectId+'/files';
  function clearSharedEditor(){
    setEditorReady(false);setEditorFailed(false);setEditing(false);setEditorVersion(0);
    setAgents('');setEnv('');setFields(projectConfigFields(emptyEnv));savedEditor.current=null;editedFields.current.clear();
  }
  function clearAccess(){
    refreshVersion.current++;clearSharedEditor();setView(null);setDevices([]);setRunnerId('');setDirectory('');setGitUsername('');setGitToken('');setDeploymentAccess(false);setPersonalEditing(false);setPick(null);setNotice('');setLoadFailed(false);setAccessDenied(true);
  }
  async function refresh(preferredRunnerId=runnerId,preserveDraft=false){
    const version=++refreshVersion.current;
    const [next,available]=await Promise.all([
      accountRequest(path,viewSchema),
      accountRequest('/devices',devicesSchema).then(value=>value.devices.filter(device=>!device.revoked)).catch(()=>[]),
    ]);
    if(version!==refreshVersion.current)return;
    if(!next.canEdit)clearSharedEditor();
    setView(current=>current&&preserveDraft&&personalDraftRef.current?{...next,personal:current.personal}:next);
    setDevices(available);
    if(!preserveDraft){
      const selected=next.personal.find(item=>item.runnerId===preferredRunnerId)??(!preferredRunnerId?next.personal[0]:undefined);
      if(selected)setRunnerId(selected.runnerId);
      else if(!preferredRunnerId&&available[0])setRunnerId(available[0].runnerId);
    }
    return next;
  }
  async function handleOperationError(error:unknown,message:string){
    if(error instanceof AccountRequestError&&error.status===401){clearAccess();return;}
    if(denied(error)){
      try{await refresh(runnerId,true);}
      catch(accessError){if(denied(accessError)){clearAccess();return;}}
    }
    setNotice(message);
  }
  useEffect(()=>{
    let cancelled=false;setLoadFailed(false);setEditorFailed(false);setAccessDenied(false);
    refreshVersion.current++;setView(null);setDevices([]);setRunnerId('');setDirectory('');setGitUsername('');setGitToken('');setDeploymentAccess(false);setEditorReady(false);setEditing(false);setPersonalEditing(false);savedEditor.current=null;setPick(null);setNotice('');
    void refresh('').catch(error=>{if(!cancelled){if(denied(error))clearAccess();else setLoadFailed(true);}});
    return()=>{cancelled=true;refreshVersion.current++;};
  },[projectId,loadRevision]);
  useEffect(()=>{
    if(active&&!wasActive.current)void refresh(runnerId,true).then(next=>{
      if(next?.canEdit&&tab==='config'&&!editingRef.current)setEditorRevision(value=>value+1);
    }).catch(error=>{if(denied(error))clearAccess();else setNotice('最新配置暂时无法读取，当前修改已保留。');});
    wasActive.current=active;
  },[active]);
  useEffect(()=>{
    if(!view)return;
    const selected=view.personal.find(item=>item.runnerId===runnerId);
    const runnerChanged=previousRunnerId.current!==runnerId;previousRunnerId.current=runnerId;
    if(!runnerChanged&&(personalEditing||!selected))return;
    if(runnerChanged){setGitToken('');setPersonalEditing(false);setNotice('');}
    if(selected){setDirectory(selected.directory);setGitUsername(selected.gitUsername);setDeploymentAccess(selected.deploymentAccess);}
    else {setDirectory('');setGitUsername('');setGitToken('');setDeploymentAccess(false);}
  },[view,runnerId]);
  useEffect(()=>{if(pick&&pick.runnerId!==runnerId)setPick(null);},[pick,runnerId]);
  useEffect(()=>{
    if(!pick)return;
    const controller=new AbortController();let timer:number|undefined;
    const poll=async()=>{
      try{
        const result=await accountRequest(path+'/directory-pick/'+pick.id,directoryPickStatus,{signal:controller.signal});
        if(controller.signal.aborted)return;
        if(result.state==='selected'&&result.directory){setDirectory(result.directory);setPick(null);setNotice('目录已选中，请保存我的配置。');return;}
        if(['cancelled','unavailable','expired'].includes(result.state)){
          setPick(null);setNotice(result.state==='cancelled'?'已取消目录选择。':result.state==='expired'?'目录选择已过期，请重试。':'无法打开目录选择器，请检查 Runner。');return;
        }
        timer=window.setTimeout(()=>void poll(),1500);
      }catch(error){if(!controller.signal.aborted){setPick(null);await handleOperationError(error,'目录选择状态读取失败，请重试。');}}
    };
    void poll();return()=>{controller.abort();window.clearTimeout(timer);};
  },[projectId,pick]);
  useEffect(()=>{
    if(!view?.canEdit||tab!=='config'){setEditorReady(false);return;}
    let active=true;setEditorReady(false);setEditorFailed(false);
    void accountRequest(path+'/editor',editorSchema).then(value=>{
      if(!active)return;
      const text=value.version?value.env:emptyEnv;
      setFields(projectConfigFields(text));editedFields.current.clear();setEditorVersion(value.version);
      setAgents(value.version?value.agentsMd:emptyAgents);setEnv(text);setEditorReady(true);
      savedEditor.current=value;setEditing(value.version===0);
    }).catch(async error=>{if(active){setEditorFailed(true);if(denied(error))await handleOperationError(error,'');}});
    return()=>{active=false;};
  },[projectId,view?.canEdit,tab,editorRevision]);
  const wasEditing=useRef(editing),wasPersonalEditing=useRef(personalEditing);
  useEffect(()=>{if(wasEditing.current&&!editing&&active)editButton.current?.focus();wasEditing.current=editing;},[editing,active]);
  const selectedPersonal=useMemo(()=>view?.personal.find(item=>item.runnerId===runnerId),[view,runnerId]);
  const editingPersonal=personalEditing||!selectedPersonal;
  useEffect(()=>{if(wasPersonalEditing.current&&!editingPersonal&&active)personalEditButton.current?.focus();wasPersonalEditing.current=editingPersonal;},[editingPersonal,active]);
  async function pickDirectory(){
    if(!runnerId||pick||busy)return;
    setBusy(true);setNotice('');
    try{const result=await accountRequest(path+'/directory-pick',directoryPickStarted,{body:{runnerId}});setPick({id:result.id,runnerId});setNotice('请在所选 Runner 的电脑上选择目录。');}
    catch(error){await handleOperationError(error,'无法发起目录选择，请确认 Runner 在线。');}
    finally{setBusy(false);}
  }
  async function saveShared(){
    if(!view?.canEdit||!editorReady||!editing||busy)return;setBusy(true);setNotice('');
    try{
      const merged=mergeProjectConfigEnv(env,fields);
      if(new TextEncoder().encode(agents).length>8000)throw new ProjectConfigError('AGENTS.md 超过 8000 字节，请精简后保存。');
      const result=await accountRequest(path,actionSchema,{body:{expectedVersion:editorVersion,agentsMd:agents,env:merged}});
      const version=result.version??editorVersion+1;
      setEditorVersion(version);setEnv(merged);
      setView(current=>current?{...current,version,config:publicProjectConfig(merged)}:current);
      savedEditor.current={version,agentsMd:agents,env:merged};editedFields.current.clear();setEditing(false);
      setNotice('项目配置已保存。');
    }
    catch(error){await handleOperationError(error,error instanceof ProjectConfigError?error.message:error instanceof Error&&'status' in error&&error.status===409?'配置版本已变化，请保留当前内容，刷新后重新保存。':'项目配置未保存，请检查网络后重试。');}
    finally{setBusy(false);}
  }
  function cancelEditing(){
    const saved=savedEditor.current;if(!saved||busy)return;
    setAgents(saved.agentsMd);setEnv(saved.env);setFields(projectConfigFields(saved.env));
    editedFields.current.clear();setNotice('');setEditing(false);
  }
  function changeField(field:keyof ProjectConfigFields,value:string){
    editedFields.current.add(field);setFields(current=>({...current,[field]:value}));
  }
  function changeEnv(text:string){
    setEnv(text);
    try{
      const imported=projectConfigFields(text);
      setFields(current=>Object.fromEntries(Object.entries(imported).map(([key,value])=>[key,editedFields.current.has(key as keyof ProjectConfigFields)?current[key as keyof ProjectConfigFields]:value])) as ProjectConfigFields);
    }catch{/* Allow incomplete dotenv while typing; saving reports the format error. */}
  }
  async function savePersonal(){
    if(!view||!editingPersonal||busy||pick||!runnerId||!directory.trim()||!gitUsername.trim())return;setBusy(true);setNotice('');
    try{
      await accountRequest(path+'/personal',actionSchema,{body:{runnerId,directory,gitUsername,...(gitToken?{gitToken}:{}),deploymentAccess,expectedVersion:selectedPersonal?.version??0}});
      const saved={runnerId,directory:directory.trim(),gitUsername:gitUsername.trim(),hasGitToken:!!gitToken||!!selectedPersonal?.hasGitToken,deploymentAccess,version:(selectedPersonal?.version??0)+1};
      setView(current=>current?{...current,personal:[...current.personal.filter(item=>item.runnerId!==runnerId),saved]}:current);
      setGitToken('');setPick(null);setPersonalEditing(false);setNotice('我的配置已保存。');
    }
    catch(error){await handleOperationError(error,error instanceof Error&&'status' in error&&error.status===409?'配置版本已变化，请保留当前内容，刷新后重新保存。':'我的配置保存失败，请检查网络、Runner 和工作目录后重试。');}finally{setBusy(false);}
  }
  function cancelPersonalEditing(){
    if(busy||!selectedPersonal)return;
    setDirectory(selectedPersonal.directory);setGitUsername(selectedPersonal.gitUsername);setDeploymentAccess(selectedPersonal.deploymentAccess);
    setGitToken('');setPick(null);setNotice('');setPersonalEditing(false);
  }
  async function initialize(mode:'initialize'|'sync'){
    if(!view?.config?.repositoryUrl){setNotice('尚未配置代码仓库，请由项目 Owner 在“项目配置”填写并保存。');return;}
    if(!view||!runnerId||!selectedPersonal||editingPersonal||busy)return;setBusy(true);setNotice('');
    try{await accountRequest(path+'/'+mode,actionSchema,{body:{runnerId,requestId:crypto.randomUUID(),expectedVersion:view.version,personalVersion:selectedPersonal.version}});await refresh();setNotice(mode==='initialize'?'初始化已提交，Runner 将在后台执行。':'同步已提交，Runner 将检查本地修改。');}
    catch(error){await handleOperationError(error,error instanceof Error&&'status' in error&&error.status===428?'尚未配置代码仓库，请由项目 Owner 在“项目配置”填写并保存。':'操作未提交，请先保存我的配置并确认 Runner 在线。');}finally{setBusy(false);}
  }
  if(!view)return <section className="project-files-page" aria-label={tab==='config'?'项目配置':'我的配置'}>{loadFailed||accessDenied?<div className="project-files-load-error"><p role="alert">{accessDenied?'项目配置访问已失效，请确认项目权限后重试。':'项目配置暂时无法读取，请重试。'}</p><button className="secondary-button" type="button" onClick={()=>setLoadRevision(value=>value+1)}>重新加载配置</button></div>:<p role="status">正在读取项目配置…</p>}</section>;
  return <section className="project-files-page" aria-label={tab==='config'?'项目配置':'我的配置'}>
    <header className="project-files-heading"><h2>{tab==='config'?'项目配置':'我的配置'}</h2><span>{tab==='config'?'Owner 维护 AGENTS.md 与项目配置，成员只读取公开摘要。':'配置本人的 Runner、工作目录与初始化操作。'}</span></header>
    {tab==='config'?<section className="project-files-panel"><h3>公开摘要</h3>{view.config?<dl><dt>代码仓库</dt><dd>{view.config.repositoryUrl||'未设置'}</dd><dt>分支</dt><dd>{view.config.branch}</dd><dt>部署环境</dt><dd>{view.config.deployEnvironment||'未设置'}</dd>{view.config.serverHost&&<><dt>服务器</dt><dd>{view.config.serverHost}</dd></>}</dl>:<p className="project-files-muted">项目 Owner 尚未配置项目文件。</p>}
        {view.canEdit&&<div className="project-files-editor">{editorReady&&!editing?<>
          <dl><dt>部署方式</dt><dd>{fields.deploymentTarget==='tcb'?'TCB / CloudBase':fields.deploymentTarget==='server'?'服务器':'暂不配置'}</dd>
            {fields.deploymentTarget==='tcb'&&<><dt>TCB 环境 ID</dt><dd>{fields.cloudbaseEnvId||'未设置'}</dd><dt>TCB 地域</dt><dd>{fields.cloudbaseRegion||'未设置'}</dd></>}
          </dl>
          <div className="project-files-actions"><button ref={editButton} type="button" onClick={()=>{setNotice('');setEditing(true);}}>编辑配置</button></div>
        </>:editorReady?<fieldset disabled={busy} className="project-files-fields">
          <div className="project-files-grid">
            <label>代码仓库<input autoFocus={active} value={fields.repositoryUrl} onChange={event=>changeField('repositoryUrl',event.target.value)} maxLength={2048} placeholder="HTTPS 仓库地址（初始化前填写）"/></label>
            <label><span>分支 <span aria-hidden="true">*</span></span><input aria-label="分支" aria-required="true" value={fields.branch} onChange={event=>changeField('branch',event.target.value)} maxLength={160}/></label>
            <label>部署方式<select aria-label="部署方式" value={fields.deploymentTarget} onChange={event=>changeField('deploymentTarget',event.target.value)}><option value="none">暂不配置</option><option value="tcb">TCB / CloudBase</option><option value="server">服务器</option></select></label>
            <label>部署环境<input value={fields.deployEnvironment} onChange={event=>changeField('deployEnvironment',event.target.value)} maxLength={80} placeholder="例如 production"/></label>
            {fields.deploymentTarget==='tcb'&&<><label>TCB 环境 ID<input value={fields.cloudbaseEnvId} onChange={event=>changeField('cloudbaseEnvId',event.target.value)} maxLength={128}/></label><label>TCB 地域<input value={fields.cloudbaseRegion} onChange={event=>changeField('cloudbaseRegion',event.target.value)} maxLength={80} placeholder="例如 ap-shanghai"/></label></>}
            {fields.deploymentTarget==='server'&&<label>服务器地址<input value={fields.serverHost} onChange={event=>changeField('serverHost',event.target.value)} maxLength={253} placeholder="主机名或 IP"/></label>}
          </div>
          <div className="project-files-documents">
            <label>AGENTS.md<textarea aria-label="AGENTS.md" value={agents} onChange={event=>setAgents(event.target.value)} maxLength={8000}/></label>
            <label>.deploy-access.env<textarea aria-label=".deploy-access.env" value={env} onChange={event=>changeEnv(event.target.value)} maxLength={24000} spellCheck={false} autoComplete="off"/></label>
          </div>
          <div className="project-files-actions project-files-save"><button type="button" disabled={busy} onClick={()=>void saveShared()}>{busy?'保存中…':'保存修改'}</button>{editorVersion>0&&<button type="button" disabled={busy} onClick={cancelEditing}>取消编辑</button>}</div>
        </fieldset>:editorFailed?<div className="project-files-load-error"><p role="alert">项目文件暂时无法读取，公开摘要仍可查看。</p><button type="button" onClick={()=>setEditorRevision(value=>value+1)}>重新加载编辑器</button></div>:<p className="project-files-muted" role="status">正在读取项目文件…</p>}</div>}
      </section>:<section className="project-files-panel"><h3>我的配置</h3>
        <dl><dt>代码仓库</dt><dd>{view.config?.repositoryUrl||'未设置'}</dd></dl>
        {editingPersonal?<fieldset className="project-files-fields" disabled={busy}>
          <label><span>Runner <span aria-hidden="true">*</span></span><select aria-label="Runner" aria-required="true" value={runnerId} onChange={event=>setRunnerId(event.target.value)}><option value="">选择 Runner</option>{devices.map(device=><option key={device.runnerId} value={device.runnerId}>{device.name}{device.online?' · 在线':' · 离线'}</option>)}</select></label>
          <div className="project-files-directory"><label><span>本机工作目录 <span aria-hidden="true">*</span></span><input aria-label="本机工作目录" aria-required="true" autoFocus={active&&personalEditing} value={directory} onChange={event=>setDirectory(event.target.value)} placeholder="/Users/you/work/project"/></label>
          <button type="button" disabled={busy||!!pick||!devices.find(device=>device.runnerId===runnerId)?.online} onClick={()=>void pickDirectory()}>{pick?'等待选择目录…':'选择目录'}</button></div>
          <div className="project-files-grid">
          <label><span>Git 用户名 <span aria-hidden="true">*</span></span><input aria-label="Git 用户名" aria-required="true" value={gitUsername} onChange={event=>setGitUsername(event.target.value)}/></label>
          <label>Git 令牌<input type="password" autoComplete="off" value={gitToken} onChange={event=>setGitToken(event.target.value)} placeholder={selectedPersonal?.hasGitToken?'已保存，留空保持不变':'仅保存在服务端加密存储'}/></label>
          </div>
          {view.canEdit&&<label className="project-files-check"><input type="checkbox" checked={deploymentAccess} onChange={event=>setDeploymentAccess(event.target.checked)}/>允许此 Runner 使用部署凭据</label>}
          <div className="project-files-actions project-files-save"><button type="button" disabled={busy||!!pick||!runnerId||!directory.trim()||!gitUsername.trim()} onClick={()=>void savePersonal()}>{busy?'处理中…':'保存我的配置'}</button>{selectedPersonal&&<button type="button" disabled={busy} onClick={cancelPersonalEditing}>取消编辑</button>}</div>
        </fieldset>:<div className="project-files-editor">
          <dl><dt>Runner</dt><dd>{devices.find(device=>device.runnerId===runnerId)?.name??runnerId}</dd><dt>本机工作目录</dt><dd>{selectedPersonal.directory}</dd><dt>Git 用户名</dt><dd>{selectedPersonal.gitUsername}</dd><dt>Git 令牌</dt><dd>{selectedPersonal.hasGitToken?'已保存':'未设置'}</dd>{view.canEdit&&<><dt>部署凭据</dt><dd>{selectedPersonal.deploymentAccess?'已授权':'未授权'}</dd></>}</dl>
          <div className="project-files-actions"><button ref={personalEditButton} type="button" disabled={busy} onClick={()=>{setNotice('');setPersonalEditing(true);}}>编辑配置</button><button type="button" disabled={busy||view.version===0} onClick={()=>void initialize('initialize')}>初始化</button><button type="button" disabled={busy||view.version===0} onClick={()=>void initialize('sync')}>同步配置</button></div>
        </div>}
        {!devices.length&&<p className="project-files-muted">请先在“管理 Runner”配置可用设备。</p>}{view.jobs[0]&&<p className="project-files-status">最近一次：{view.jobs[0].state}{view.jobs[0].result?` · ${view.jobs[0].result}`:''}</p>}
      </section>}
    {notice&&<p className="project-files-notice" role="status">{notice}</p>}
  </section>;
}
