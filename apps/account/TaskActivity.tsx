import RequiredMark from './RequiredMark';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {usePageState,usePageRef} from './page-state';
import {assessmentSchema} from '../../packages/domain/assessment-schema';
import {taskStatusLabel} from './task-status';
const item=z.object({id:z.string(),type:z.enum(['comment','agent_conclusion','operation']),timestamp:z.string(),actorType:z.enum(['member','agent','system']),actorId:z.string().nullable(),displayName:z.string().nullable(),agentId:z.string().nullable(),ownerName:z.string().nullable(),body:z.string(),operation:z.string().nullable(),inputRevision:z.number().nullable(),attemptId:z.string().nullable(),reviewStatus:z.string().nullable(),fromState:z.string().nullable(),toState:z.string().nullable()}).strict();
const listing=z.object({identityId:z.string(),projectId:z.string(),taskId:z.string(),items:z.array(item),hasMore:z.boolean(),nextCursor:z.string().nullable()}).strict();
const receipt=z.object({identityId:z.string(),projectId:z.string(),taskId:z.string(),comment:z.object({id:z.string(),type:z.literal('comment'),timestamp:z.string(),actorId:z.string(),actorType:z.literal('member'),displayName:z.string(),body:z.string(),inputRevision:z.number()}).strict()}).strict();
const operations:Record<string,string>={publication:'发布任务',rework:'修订输入',retry:'人工重试',review:'人工验收',assessment_approval:'批准评估',stop_confirmation:'确认停止',assigned:'分配执行',started:'开始执行',execution_report:'提交成果',assessment_report:'评估报告',stopped:'执行停止',assessment_deadline:'评估超时',coordinator_resume:'恢复协调'};
const statuses:Record<string,string>={pending:'待验收',accepted:'已通过',rejected:'已驳回',valid:'评估有效',invalid:'评估无效',approval_required:'待批准',approved:'已批准',unknown:'历史结果未记录',failed:'失败'};
const stateLabels:Record<string,string>=taskStatusLabel;
// Legacy activity responses distinguish assessment starts in their fixed body text.
const systemEvents:Record<string,{body:string;title?:string}[]>={
 publication:[{body:'Task published'}],assessment_approval:[{body:'Assessment risk approved'}],
 retry:[{body:'人工重试执行'}],
 stop_confirmation:[{body:'Stopped execution confirmed'}],
 assigned:[{body:'Assessment assigned',title:'分配评估'},{body:'Execution assigned'}],
 started:[{body:'Assessment started',title:'开始评估'},{body:'Execution started'}],
 stopped:[{body:'Execution stopped'}],assessment_deadline:[{body:'Assessment correction deadline exhausted'}],
 coordinator_resume:[{body:'Coordinator resumed'}],
};
function ActivityEntry({event}:{event:z.infer<typeof item>}){
 const isAssessment=event.type==='operation'&&event.operation==='assessment_report';
 let assessment:z.infer<typeof assessmentSchema>|undefined;
 let assessmentText='';
 if(isAssessment){
  try{const parsed=assessmentSchema.safeParse(JSON.parse(event.body));if(parsed.success)assessment=parsed.data;}
  catch(error){
   if(!(error instanceof SyntaxError))throw error;
   if(!/^\s*(?:\{|\[|```)/.test(event.body))assessmentText=event.body;
  }
 }
 const systemEvent=event.type==='operation'&&event.operation?systemEvents[event.operation]?.find(value=>value.body===event.body):undefined;
 const title=event.type==='agent_conclusion'?'执行结论':event.type==='comment'?'':event.operation==='stopped'&&event.toState===null?'评估停止':systemEvent?.title??(event.operation?operations[event.operation]??'操作记录':'操作记录');
 const compact=!!systemEvent&&!event.reviewStatus;
 return <li className={'activity-'+event.type+(compact?' activity-compact':'')}>
  <div className="activity-byline"><strong>{event.actorType==='system'?'系统':event.displayName??'历史作者未记录'}</strong><span>{event.actorType==='agent'?'Agent'+(event.ownerName?' · '+event.ownerName:''):event.actorType==='member'?'成员':''}</span>{compact&&<span className="activity-operation-label">{title}</span>}<time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleString('zh-CN')}</time></div>
  {!compact&&(title||event.reviewStatus)&&<div className="activity-heading">{title}{event.reviewStatus&&<span className="role-label">{statuses[event.reviewStatus]??'历史结果未记录'}</span>}</div>}
  {assessment?<>
   <dl className="activity-assessment">
    <div><dt>难度</dt><dd>{assessment.difficulty} / 5</dd></div>
    <div><dt>风险</dt><dd>{({low:'低',medium:'中',high:'高'})[assessment.risk]}</dd></div>
    <div><dt>置信度</dt><dd>{Math.round(assessment.confidence*100)}%</dd></div>
    <div><dt>所需能力</dt><dd>{assessment.requiredCapability==='coding'?'代码':'文字'}</dd></div>
   </dl>
   <p>{assessment.rationale}</p>
  </>:isAssessment?<p>{assessmentText||'评估报告暂无法整理，请展开记录详情查看原文。'}</p>:!systemEvent&&event.body?<p>{event.body}</p>:null}
  <details className="activity-details"><summary>记录详情</summary>
   <dl><dt>任务内容版本</dt><dd>{event.inputRevision===null?'历史版本未记录':'第 '+event.inputRevision+' 版'}</dd>
    {event.attemptId&&<><dt>运行记录编号</dt><dd>{event.attemptId}</dd></>}
    {event.fromState&&event.toState&&<><dt>任务状态</dt><dd>{stateLabels[event.fromState]??'未知状态'} → {stateLabels[event.toState]??'未知状态'}</dd></>}
   </dl>
   <p className="field-hint">版本对应当时使用的任务内容，修订后递增。{event.attemptId?'编号用于关联同一次评估或执行的记录，不是重试次数。':''}</p>
   {isAssessment&&<><p className="field-hint">原始评估报告</p><pre>{event.body}</pre></>}
  </details>
 </li>;
}
export default function TaskActivity({identityId,projectId,taskId,readOnly,refreshVersion}:{identityId:string;projectId:string;taskId:string;readOnly:boolean;refreshVersion:number}){
 const scope='project.'+projectId+'.task.'+taskId+'.comments',path='/projects/'+projectId+'/tasks/'+taskId;
 const [draft,setDraft]=usePageState(scope+'.draft',z.string().max(4000),'');
 const pending=usePageRef(scope+'.pending',z.object({requestId:z.uuid(),body:z.string().max(4000)}).nullable(),null);
 const [filter,setFilter]=usePageState(scope+'.filter',z.enum(['all','comments','operations']),'all');
 const [data,setData]=useState<z.infer<typeof listing>|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[allowed,setAllowed]=useState(true);
 const alive=useRef(true),generation=useRef(0),sending=useRef(false);
 async function load(older=false){
  const current=++generation.current;
  const result=await accountRequest(path+'/activity'+(older&&data?.nextCursor?'/before/'+encodeURIComponent(data.nextCursor):''),listing);
  if(!alive.current||current!==generation.current)return;
  if(result.identityId!==identityId||result.projectId!==projectId||result.taskId!==taskId)throw new AccountRequestError(403);
  setAllowed(true);setNotice('');setData(previous=>older&&previous?{...result,items:[...previous.items,...result.items.filter(i=>!previous.items.some(p=>p.id===i.id))]}:result);
 }
 function fail(error:unknown){if(!alive.current)return;if(denied(error)){setData(null);setAllowed(false);}setNotice(denied(error)?'访问已撤销，本机草稿仍保留。':'动态暂未确认，请重试。');}
 useEffect(()=>{alive.current=true;void load().catch(fail);return()=>{alive.current=false;++generation.current;};},[identityId,projectId,taskId,refreshVersion]);
 async function send(){
  if(sending.current||readOnly||!allowed)return;
  // An uncertain request stays immutable until explicitly retried, even if a new draft was typed.
  const request=pending.current??{requestId:crypto.randomUUID(),body:draft.trim()};if(!request.body)return;
  pending.current=request;sending.current=true;setBusy(true);setNotice('');
  try{
   const result=await accountRequest(path+'/comments',receipt,{body:{identityId,...request}});
   if(!alive.current)return;
   if(result.identityId!==identityId||result.projectId!==projectId||result.taskId!==taskId)throw new AccountRequestError(403);
   pending.current=null;setDraft(current=>current.trim()===request.body?'':current);
   await load();
  }catch(error){fail(error);}finally{sending.current=false;if(alive.current)setBusy(false);}
 }
 const items=(data?.items??[]).filter(i=>filter==='all'||(filter==='operations'?i.type==='operation':i.type!=='operation')).slice().reverse();
 return <section className="task-activity" aria-label="任务动态"><h4>动态</h4>
  <div className="activity-tabs" role="group" aria-label="动态筛选">{(['all','comments','operations'] as const).map(value=><button key={value} className="activity-tab" aria-pressed={filter===value} onClick={()=>setFilter(value)}>{value==='all'?'全部':value==='comments'?'评论':'操作记录'}</button>)}</div>
  {notice&&<p role="alert">{notice}<button className="text-button" onClick={()=>void load().catch(fail)}>重试读取</button></p>}
  {data?.hasMore&&<button className="text-button" onClick={()=>void load(true).catch(fail)}>加载更早动态</button>}
  {!data&&!notice&&<p className="field-hint" role="status">正在读取动态…</p>}
  {data&&items.length===0&&<p className="field-hint">{filter==='comments'?'暂无评论':filter==='operations'?'暂无操作记录':'暂无动态'}</p>}
  <ol className="activity-stream">{items.map(event=><ActivityEntry key={event.id} event={event}/>)}</ol>
  {!readOnly&&<form className="story-form" onSubmit={e=>{e.preventDefault();void send();}}>
   <label htmlFor={'comment-'+taskId}>评论内容<RequiredMark/></label><textarea id={'comment-'+taskId} aria-required="true" maxLength={4000} value={draft} onChange={e=>setDraft(e.target.value)} disabled={!allowed}/>
   <p className="field-hint">评论可作为后续 Agent 的任务上下文。</p>
   <button className="primary-button" disabled={busy||!allowed||(!pending.current&&!draft.trim())}>{pending.current?'重试上次评论':'发表评论'}</button>
  </form>}
 </section>;
}
