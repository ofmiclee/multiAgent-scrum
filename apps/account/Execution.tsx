import RequiredMark from './RequiredMark';
import BodyContent from './BodyContent';
import {bodyImageReferences} from '../../packages/domain/body-images';
import TaskActivity from './TaskActivity';
import TaskConversation from './TaskConversation';
import TaskRetry from './TaskRetry';
import type {projectRole} from './hierarchy';
import HelpTip from './HelpTip';
import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {assessmentSchema} from '../../packages/domain/assessment-schema';
import {agentListingSchema} from './Agents';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {taskStatusSchema,taskStatusLabel} from './task-status';
import {coordinatorCandidates} from './coordinator-options';
import TaskRework,{historySchema} from './TaskRework';
import {usePageState} from './page-state';
import {taskPresentation,TaskPeople,TaskAttention} from './TaskPresentation';
import './execution.css';
const coordinatorSchema=z.object({identityId:z.string(),coordinator:z.object({agentId:z.uuid().nullable(),version:z.number().int().min(0),available:z.boolean(),paused:z.boolean(),pauseReason:z.string().nullable()}).strict()}).strict();
const workState=z.enum(['queued','active','review','done','failed']);
const taskSchema=z.object({id:z.uuid(),boardId:z.uuid(),title:z.string(),objective:z.string(),acceptanceCriteria:z.string(),requiredCapabilities:z.array(z.string()),status:taskStatusSchema,
  presentation:taskPresentation.optional(),
  assessment:z.object({state:workState,calls:z.number().int(),approved:z.boolean(),result:assessmentSchema.nullable(),issues:z.array(z.string()),attemptId:z.uuid().nullable()}).strict().nullable(),
  execution:z.object({state:workState,attemptId:z.uuid().nullable(),summary:z.string().nullable(),artifacts:z.array(z.object({name:z.string(),content:z.string()}).strict()),issues:z.array(z.string())}).strict().nullable(),
}).strict();
export const taskList=z.object({identityId:z.string(),projectId:z.uuid(),tasks:z.array(taskSchema).max(50),hasMore:z.boolean(),nextCursor:z.uuid().nullable()}).strict();
const commandReceipt=z.object({identityId:z.string(),ok:z.literal(true)}).strict();
function issueText(issue:string){
  if(issue==='Execution stopped'||issue==='Execution stopped; inspect permissions, account and prior attempt before retrying')return '执行已停止。旧记录未包含具体原因，请查看最近的实时对话或 Runner 记录，再核对是否可以重试。';
  return issue;
}
function TaskRevision({identityId,projectId,taskId,refreshVersion}:{identityId:string;projectId:string;taskId:string;refreshVersion:number}){
 const [revision,setRevision]=useState<number|null>(null);
 useEffect(()=>{const controller=new AbortController();setRevision(null);void accountRequest('/projects/'+projectId+'/tasks/'+taskId+'/rework',historySchema,{signal:controller.signal}).then(r=>{if(!controller.signal.aborted&&r.identityId===identityId&&r.taskId===taskId)setRevision(r.revision);}).catch(()=>{});return()=>controller.abort();},[identityId,projectId,taskId,refreshVersion]);
 return <><dt>输入版本</dt><dd>{revision===null?'尚未确认':'第 '+revision+' 版'}</dd></>;
}
type Command={path:string;body:object;coordinator?:boolean;feedbackKey?:string};

export default function Execution({identityId,project,boardId,onBack,initialPages=[],focusTaskId,embedded=false}:{identityId:string;project:{id:string;role:z.infer<typeof projectRole>};boardId:string;onBack:()=>void;initialPages?:string[];focusTaskId?:string;embedded?:boolean}){
  const [data,setData]=useState<z.infer<typeof taskList>|null>(null),[coordinator,setCoordinator]=useState<z.infer<typeof coordinatorSchema>['coordinator']|null>(null);
  const [activityVersion,setActivityVersion]=useState(0);
  const [conversationOpen,setConversationOpen]=useState(false);
  const [agents,setAgents]=useState<z.infer<typeof agentListingSchema>['agents']>([]);
  const [selection,setSelection]=usePageState('project.'+project.id+'.coordinator-draft',z.object({agentId:z.string(),version:z.number().int().nonnegative()}).nullable(),null);
  const selected=selection?.agentId??coordinator?.agentId??'';
  const [feedback,setFeedback]=usePageState('project.'+project.id+'.feedback',z.record(z.string(),z.string().max(2000)),{}),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [pages,setPages]=usePageState('project.'+project.id+'.execution-pages',z.array(z.uuid()).max(100),[...initialPages]),[reading,setReading]=useState(false);
  const pageHeading=useRef<HTMLHeadingElement|null>(null),didFocus=useRef(false);
  useEffect(()=>{if(data&&focusTaskId&&!didFocus.current&&pageHeading.current){pageHeading.current.focus({preventScroll:true});didFocus.current=true;}},[data]);
  const alive=useRef(false),sequence=useRef(0),controller=useRef<AbortController|null>(null),working=useRef(false),path='/projects/'+project.id;
  const cursor=pages.at(-1),taskPath=focusTaskId?path+'/boards/'+boardId+'/tasks/'+focusTaskId:path+'/tasks'+(cursor?'/before/'+cursor:'');
  const load=useCallback(async()=>{
    const generation=++sequence.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;
    const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(10000)]);
    setReading(true);
    try{
    const [tasks,loop,resources]=await Promise.all([accountRequest(taskPath,taskList,{signal,taskPresentation:true}),
      project.role==='owner'&&!focusTaskId&&!embedded?accountRequest(path+'/coordinator',coordinatorSchema,{signal}):Promise.resolve({identityId,coordinator:null}),
      project.role==='owner'&&!focusTaskId&&!embedded?accountRequest(path+'/agent-grants',agentListingSchema,{signal}):Promise.resolve({identityId,agents:[]})]);
    if(!alive.current||abort.signal.aborted||generation!==sequence.current)return;
    if(tasks.identityId!==identityId||loop.identityId!==identityId||resources.identityId!==identityId||tasks.projectId!==project.id)throw new AccountRequestError(403);
    if(focusTaskId&&(tasks.tasks.length!==1||tasks.tasks[0].id!==focusTaskId||tasks.tasks[0].boardId!==boardId))throw new AccountRequestError(404);
    setData(tasks);setCoordinator(loop.coordinator);setAgents(resources.agents);setActivityVersion(value=>value+1);
    }finally{if(alive.current&&generation===sequence.current)setReading(false);}
  },[path,taskPath,project.id,project.role,identityId,focusTaskId,boardId,embedded]);
  function fail(error:unknown){if(!alive.current)return;setData(null);setCoordinator(null);setAgents([]);setNotice(denied(error)?focusTaskId?'任务不可用：不存在于此看板，或当前账号已无权访问。草稿仍保留在本机。':'账号已变化或项目访问已撤销，请返回后重新登录。':'执行状态暂时无法确认，请刷新重试。');}
  useEffect(()=>{alive.current=true;void load().catch(error=>{if(!(error instanceof DOMException&&error.name==='AbortError'))fail(error);});return()=>{alive.current=false;++sequence.current;controller.current?.abort();};},[load]);
  async function submit(command:Command){
    if(working.current)return;working.current=true;setBusy(true);setNotice('');++sequence.current;controller.current?.abort();
    try{
      const options={body:{identityId,...command.body}};
      const response=command.coordinator?await accountRequest(command.path,coordinatorSchema,options):await accountRequest(command.path,commandReceipt,options);
      if(!alive.current)return;if(response.identityId!==identityId)throw new AccountRequestError(403);
      if(command.coordinator)setSelection(null);
      if(command.feedbackKey)setFeedback(current=>{const next={...current};delete next[command.feedbackKey!];return next;});
      try{await load();}catch(error){fail(error);if(alive.current&&!denied(error))setNotice('操作已提交，但当前状态无法读取，请刷新确认。');}
    }catch(error){if(alive.current){
      if(denied(error)){fail(error);}
      else if(error instanceof AccountRequestError&&error.status===409){try{await load();}catch(error){fail(error);}setNotice('当前版本或执行尝试已变化，请重新核对；没有自动覆盖新状态。');}
      else setNotice('操作结果尚未确认，请重试原操作，或刷新查看状态。');
    }}finally{working.current=false;if(alive.current)setBusy(false);}
  }
  const eligible=coordinatorCandidates(agents,project.id);
  const Heading=embedded?'h3':'h1';
  return <section className="execution-view" aria-label="项目自动执行">
    <div className={embedded?'section-heading':'workspace-page-heading'}><div className="heading-with-tip"><Heading ref={pageHeading} tabIndex={focusTaskId?-1:undefined}>{focusTaskId?'任务详情':embedded?'执行记录':'项目自动执行'}</Heading>{!focusTaskId&&<HelpTip label="自动执行说明">由项目所有者授权的 Codex 或 DSH 负责协调。电脑离线不代表执行已停止；验收通过后才会放行依赖任务。</HelpTip>}</div><button className="secondary-button" disabled={busy||reading} aria-busy={reading} onClick={()=>{setNotice('');void load().catch(fail);}}>刷新执行状态</button></div>
    {notice&&<div className="notice notice-error" role="alert">{notice}</div>}
    {!focusTaskId&&coordinator&&<section className="management-block" aria-label="协调配置">
      <h4>{coordinator.agentId?'已配置项目协调 Agent':'尚未配置项目协调 Agent'}</h4>
      {coordinator.paused&&<div className="notice notice-error"><p>项目协调已暂停</p><p>{coordinator.pauseReason}</p>{project.role==='owner'&&<><p className="field-hint">请先检查账号、额度和 Runner。恢复只处理排队评估，不重跑失败任务或清除执行隔离。</p><button className="secondary-button" disabled={busy} onClick={()=>void submit({path:path+'/coordinator/resume',body:{expectedVersion:coordinator.version}})}>恢复项目协调</button></>}</div>}
      <p className="field-hint">{coordinator.available?'已就绪':'未就绪，等待所有者的电脑'}</p>
      {project.role==='owner'&&<form className="story-form" onSubmit={event=>{event.preventDefault();void submit({path:path+'/coordinator',body:{agentId:selected||null,expectedVersion:selection?.version??coordinator.version},coordinator:true});}}>
        {selection&&selection.version!==coordinator.version&&<p role="alert">协调配置已变化，请重新选择 Agent 后保存。</p>}
        <label htmlFor="coordinator-agent">项目协调 Agent</label><select id="coordinator-agent" disabled={busy} value={selected} onChange={event=>setSelection({agentId:event.target.value,version:coordinator.version})}>
          <option value="">不配置协调 Agent</option>{coordinator.agentId&&!eligible.some(a=>a.id===coordinator.agentId)&&<option value={coordinator.agentId} disabled>原配置当前不可用</option>}
          {eligible.map(a=><option key={a.id} value={a.id}>{a.name} · {a.deviceName}</option>)}
        </select><p className="field-hint">评估会使用已授权账号的额度，可能产生费用。更换或关闭配置会使旧评估失效，不会停止已有执行。</p><div className="form-actions"><button className="primary-button" disabled={busy}>保存协调 Agent</button></div>
      </form>}
    </section>}
    {!data?<p role="status">任务状态尚未确认。</p>:data.tasks.length===0?<p className="compact-empty">尚未发布任务</p>:data.tasks.filter(task=>!focusTaskId||task.id===focusTaskId).map(task=><article className={'management-block execution-task status-'+task.status} key={task.id} aria-label={task.title||'TASK-'+task.id.slice(0,6).toUpperCase()}>
      <div className={focusTaskId?"task-detail-layout":"execution-list-content"}><div className="task-detail-content"><div className="section-heading"><h4>{task.title||'TASK-'+task.id.slice(0,6).toUpperCase()}</h4><div className="task-heading-actions"><span className={'role-label task-state '+task.status}>{taskStatusLabel[task.status]}</span>{focusTaskId&&<button className="secondary-button" type="button" onClick={()=>setConversationOpen(true)}>实时对话</button>}</div></div>
      <BodyContent className="task-objective" body={task.objective} projectId={project.id}/>
      {bodyImageReferences(task.objective).length>0&&!task.assessment?.approved&&<p className="field-hint">当前 Runner 仅接收文字，无法读取正文图片。含图任务的评估需由项目负责人确认。</p>}
      {task.presentation?.recoveryRequired&&<TaskAttention status={task.status} recoveryRequired/>}
      <section className="acceptance-section" aria-label="验收标准"><h5>验收标准</h5><p>{task.acceptanceCriteria}</p></section>
      {!task.assessment&&<p className="field-hint">等待协调评估</p>}
      {task.assessment?.approved&&task.status==='pending'&&<p className="field-hint">已评估，等待分配</p>}
      {task.assessment?.state==='done'&&!task.assessment.approved&&<section className="task-current-action" aria-label="评估确认"><h5>评估需要项目所有者确认</h5>
        {task.assessment.result&&<><p className="field-hint">风险：{({low:'低',medium:'中',high:'高'})[task.assessment.result.risk]} · 置信度：{Math.round(task.assessment.result.confidence*100)}%</p><p>{task.assessment.result.rationale}</p></>}
        {project.role==='owner'&&<><p className="field-hint">批准后按现有权限自动分配；不代表部署授权或验收通过。</p><button className="primary-button" disabled={busy} onClick={()=>void submit({path:path+'/tasks/'+task.id+'/assessment-approval',body:{attemptId:task.assessment!.attemptId}})}>批准本次评估</button></>}
      </section>}
      {task.assessment?.state==='failed'&&<div className="notice notice-error"><p>本次评估失败，需要项目所有者处理。</p>{task.assessment.issues.map((issue,i)=><p key={i}>{issueText(issue)}</p>)}</div>}
      {task.execution?.issues.map((issue,i)=><p key={i} className="execution-issue">{issueText(issue)}</p>)}
      <TaskRetry key={'retry:'+identityId+':'+project.id+':'+task.id} identityId={identityId} projectId={project.id} taskId={task.id} status={task.status} readOnly={project.role!=='owner'} refreshVersion={activityVersion} onRetried={load}/>
      {task.execution&&(task.execution.summary||task.execution.artifacts.length>0)&&<section className="execution-result" aria-label="执行结果"><h4>执行结果</h4>{task.execution.summary&&<p>{task.execution.summary}</p>}{task.execution.artifacts.map((artifact,i)=><details className="execution-artifact" key={i}><summary>{artifact.name}</summary><pre>{artifact.content}</pre></details>)}</section>}
      {task.status==='review'&&<section className="task-current-action" aria-label="任务验收"><h5>待验收</h5><p className="review-guidance">成果已提交，尚未通过验收。请对照验收标准检查成果。</p>
      {['owner','manager'].includes(project.role)&&task.execution?.attemptId&&<div className="story-form">
        <label htmlFor={'feedback-'+task.id}>验收反馈<RequiredMark/></label><textarea id={'feedback-'+task.id} aria-required="true" maxLength={2000} disabled={busy} value={feedback[task.execution.attemptId]??''} onChange={event=>setFeedback(current=>({...current,[task.execution!.attemptId!]:event.target.value}))}/>
        <p className="field-hint">通过后放行依赖任务；拒绝会保存反馈，不会自动重跑。</p>
        <div className="form-actions">{(['accept','reject'] as const).map(decision=><button key={decision} className={decision==='accept'?'primary-button':'secondary-button'} disabled={busy||!feedback[task.execution!.attemptId!]?.trim()} onClick={()=>void submit({path:path+'/tasks/'+task.id+'/review',body:{attemptId:task.execution!.attemptId,decision,feedback:feedback[task.execution!.attemptId!].trim()},feedbackKey:task.execution!.attemptId!})}>{decision==='accept'?'验收通过':'拒绝验收'}</button>)}</div>
      </div>}</section>}
      {!focusTaskId&&<TaskPeople value={task.presentation}/>}
      {task.assessment&&<details className="execution-technical"><summary>评估详情</summary>
        <p className="field-hint">评估调用 {task.assessment.calls} / 4</p>
        {task.assessment.result&&<><dl className="activity-assessment"><div><dt>难度</dt><dd>{task.assessment.result.difficulty} / 5</dd></div><div><dt>风险</dt><dd>{({low:'低',medium:'中',high:'高'})[task.assessment.result.risk]}</dd></div><div><dt>置信度</dt><dd>{Math.round(task.assessment.result.confidence*100)}%</dd></div></dl><p>{task.assessment.result.rationale}</p></>}
        {task.assessment.state!=='failed'&&task.assessment.issues.map((issue,i)=><p key={i} className="field-hint">{issueText(issue)}</p>)}
      </details>}
      <div className="task-rework-entry"><TaskRework readOnly={project.role==='viewer'} identityId={identityId} projectId={project.id} task={task} onSaved={load}/></div>
      {focusTaskId&&<TaskActivity key={task.id} refreshVersion={activityVersion} identityId={identityId} projectId={project.id} taskId={task.id} readOnly={project.role==='viewer'}/>}
      {focusTaskId&&conversationOpen&&<TaskConversation key={identityId+':'+project.id+':'+task.id} identityId={identityId} projectId={project.id} taskId={task.id} onClose={()=>setConversationOpen(false)}/>}
      </div>{focusTaskId&&<aside className="task-property-rail" aria-label="任务属性"><h5>属性</h5><dl><dt>负责人</dt><dd>{task.presentation?task.presentation.responsibleName??'未分配':'待同步'}</dd><dt>执行 Agent</dt><dd>{task.presentation?task.presentation.agentName??'未分配':'待同步'}</dd><dt>所需能力</dt><dd>{task.requiredCapabilities.map(value=>value==='coding'?'代码':value==='writing'?'文字':value).join('、')||'等待评估'}</dd><TaskRevision refreshVersion={activityVersion} identityId={identityId} projectId={project.id} taskId={task.id}/></dl><details className="task-identifiers"><summary>任务标识</summary><dl><dt>任务编号</dt><dd><code>{task.id}</code></dd><dt>执行尝试</dt><dd>{task.execution?.attemptId?<code>{task.execution.attemptId}</code>:'尚未执行'}</dd></dl></details></aside>}</div>
    </article>)}
    {data&&!focusTaskId&&<div className="form-actions"><button className="secondary-button" disabled={busy||reading||!pages.length} onClick={()=>{setData(null);setPages(current=>current.slice(0,-1));}}>上一页任务</button><span className="field-hint">第 {pages.length+1} 页 · 每页最多 50 项</span><button className="secondary-button" disabled={busy||reading||!data.nextCursor} onClick={()=>{if(data.nextCursor){setPages(current=>[...current,data.nextCursor!]);setData(null);}}}>下一页任务</button></div>}
  </section>;
}
