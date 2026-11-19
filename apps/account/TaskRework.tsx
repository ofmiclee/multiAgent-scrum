import RequiredMark from './RequiredMark';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {usePageState,usePageRef} from './page-state';
import BodyContent from './BodyContent';
import BodyEditor from './BodyEditor';
export const historySchema=z.object({identityId:z.string(),taskId:z.uuid(),revision:z.number().int().min(1).max(4),canRework:z.boolean(),unsettled:z.boolean(),
  current:z.object({title:z.string(),objective:z.string(),acceptanceCriteria:z.string(),requiredCapabilities:z.array(z.string())}).strict(),
  history:z.array(z.object({revision:z.number(),reason:z.string(),previous:z.object({title:z.string(),objective:z.string(),acceptanceCriteria:z.string(),requiredCapabilities:z.array(z.string()),status:z.string()}).strict(),work:z.array(z.unknown()),createdAt:z.string()}).strict()).max(3),
  attempts:z.array(z.object({id:z.uuid(),fence:z.number(),state:z.string(),report:z.unknown(),finishedAt:z.string().nullable(),kind:z.string(),decision:z.string().nullable(),feedback:z.string().nullable()}).strict()).max(20),
}).strict();
const receiptSchema=z.object({identityId:z.string(),ok:z.literal(true)}).strict();
const reworkInput=z.object({identityId:z.string(),expectedRevision:z.number().int().min(1).max(4),title:z.string().max(200),objective:z.string().max(4000),acceptanceCriteria:z.string().max(4000),requiredCapability:z.enum(['coding','writing']),reason:z.string().max(500)}).strict();
type Task={id:string;title:string;objective:string;acceptanceCriteria:string;requiredCapabilities:string[]};
export default function TaskRework({identityId,projectId,task,onSaved,readOnly=false}:{readOnly?:boolean;identityId:string;projectId:string;task:Task;onSaved:()=>Promise<void>}){
  const scope='project.'+projectId+'.task.'+task.id+'.rework';
  const [uploading,setUploading]=useState(false);
  const [data,setData]=useState<z.infer<typeof historySchema>|null>(null),[opened,setOpened]=usePageState(scope+'.opened',z.boolean(),false),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [draft,setDraft]=usePageState(scope+'.draft',z.object({title:z.string().max(200),objective:z.string().max(4000),acceptanceCriteria:z.string().max(4000),requiredCapability:z.string(),reason:z.string().max(500)}),{title:task.title,objective:task.objective,acceptanceCriteria:task.acceptanceCriteria,requiredCapability:task.requiredCapabilities[0]==='coding'?'coding':'writing',reason:''});
  const [draftRevision,setDraftRevision]=usePageState(scope+'.revision',z.number().int().positive().nullable(),null),dirty=usePageRef(scope+'.dirty',z.boolean(),false);
  const alive=useRef(true),pending=usePageRef(scope+'.pending',z.object({text:z.string(),id:z.uuid()}).nullable(),null),working=useRef(false),generation=useRef(0);
  useEffect(()=>{alive.current=true;if(opened)void open();return()=>{alive.current=false;++generation.current;};},[identityId,projectId,task.id]);
  const path='/projects/'+projectId+'/tasks/'+task.id+'/rework';
  function loadCurrent(result:z.infer<typeof historySchema>){
    setDraft({title:result.current.title,objective:result.current.objective,acceptanceCriteria:result.current.acceptanceCriteria,requiredCapability:result.current.requiredCapabilities[0]==='coding'?'coding':'writing',reason:''});
    setDraftRevision(result.revision);dirty.current=false;pending.current=null;
  }
  async function read(){
    const current=++generation.current,result=await accountRequest(path,historySchema);
    if(!alive.current||current!==generation.current)return;
    if(result.identityId!==identityId||result.taskId!==task.id)throw new AccountRequestError(403);setData(result);
    if(!dirty.current)loadCurrent(result);
  }
  async function open(){if(working.current)return;setOpened(true);setNotice('');try{await read();}catch(error){if(alive.current)setNotice(denied(error)?'项目访问已变化，请返回后重新登录。':'历史暂时无法读取，请重试。');}}
  async function save(confirmPending=false){
    if(working.current||uploading||draft.objective.length>4000||(!confirmPending&&(!data?.canRework||draftRevision!==data.revision)))return;
    let body:z.infer<typeof reworkInput>;
    try{body=reworkInput.parse(confirmPending?JSON.parse(pending.current?.text??'null'):{identityId,expectedRevision:draftRevision,...draft});if(body.identityId!==identityId)throw Error('Identity mismatch');}
    catch{setNotice('保存内容无法恢复，请重新核对任务后编辑。');return;}
    working.current=true;setBusy(true);setNotice('');const current=++generation.current;
    const text=JSON.stringify(body);
    if(pending.current?.text!==text)pending.current={text,id:crypto.randomUUID()};
    try{
      const receipt=await accountRequest(path,receiptSchema,{body:{...body,requestId:pending.current.id}});
      if(!alive.current||current!==generation.current)return;
      if(receipt.identityId!==identityId)throw new AccountRequestError(403);
      const newerDraft=confirmPending&&JSON.stringify({identityId,expectedRevision:draftRevision,...draft})!==text;
      pending.current=null;dirty.current=newerDraft;await read();await onSaved();
      if(newerDraft&&alive.current)setNotice('上次保存已确认；后续草稿已保留，需核对任务当前版本后再保存。');
    }catch(error){if(alive.current){
      if(denied(error)){setData(null);setNotice('项目访问已变化，请返回后重新登录。');}
      else if(error instanceof AccountRequestError&&error.status===409){await read().catch(()=>{});setNotice('任务版本或执行状态已变化，请核对后再保存。');}
      else setNotice('保存结果尚未确认，请重试原操作；此前的执行记录仍会保留。');
    }}finally{working.current=false;if(alive.current)setBusy(false);}
  }
  const set=(field:keyof typeof draft,value:string)=>{dirty.current=true;setDraft(previous=>({...previous,[field]:value}));};
  return <section aria-label={'修订与历史：'+task.title}>
    <button className="secondary-button" disabled={busy} onClick={()=>void open()}>修订与历史</button>
    {opened&&<>
      {notice&&<p role="alert" className="notice notice-error">{notice}</p>}
      {!readOnly&&pending.current&&<button className="secondary-button" disabled={busy} onClick={()=>void save(true)}>核对上次保存结果</button>}
      {data&&<>
        <p className="field-hint">当前第 {data.revision} 版 · 最多修订 3 次</p>
        {draftRevision!==data.revision&&<p role="alert">任务已更新；当前草稿仍属于第 {draftRevision} 版，不能覆盖新版本。<button disabled={busy} onClick={()=>loadCurrent(data)}>载入当前版本</button></p>}
        {data.unsettled&&<p className="field-hint">仍有执行未确认停止，暂不能重新评估。</p>}
        {!readOnly&&data.canRework&&<form className="story-form" onSubmit={event=>{event.preventDefault();void save();}}>
          {task.title&&<><label htmlFor={'rework-title-'+task.id}>修订任务标题<RequiredMark/></label><input id={'rework-title-'+task.id} required value={draft.title} maxLength={200} disabled={busy} onChange={e=>set('title',e.target.value)}/></>}
          <div className="field-label">修订任务正文<RequiredMark/></div><BodyEditor projectId={projectId} value={draft.objective} label="修订任务正文" onChange={value=>set('objective',value)} disabled={busy} maxLength={4000} onUploading={setUploading}/>
          <label htmlFor={'rework-acceptance-'+task.id}>修订验收标准<RequiredMark/></label><textarea id={'rework-acceptance-'+task.id} required value={draft.acceptanceCriteria} maxLength={4000} disabled={busy} onChange={e=>set('acceptanceCriteria',e.target.value)}/>
          <label htmlFor={'rework-capability-'+task.id}>修订能力<RequiredMark/></label><select id={'rework-capability-'+task.id} required value={draft.requiredCapability} disabled={busy} onChange={e=>set('requiredCapability',e.target.value)}><option value="writing">文字</option><option value="coding">代码</option></select>
          <label htmlFor={'rework-reason-'+task.id}>修订原因<RequiredMark/></label><textarea id={'rework-reason-'+task.id} required value={draft.reason} maxLength={500} disabled={busy} onChange={e=>set('reason',e.target.value)}/>
          <p className="field-hint">保存后使用已授权协调 Agent 重新评估，可能产生费用。此前结果和反馈会保留，执行后仍需人工验收。</p>
          <button className="primary-button" disabled={busy||uploading||draft.objective.length>4000||draftRevision!==data.revision||![(task.title?draft.title:'direct'),draft.objective,draft.acceptanceCriteria,draft.reason].every(v=>v.trim())}>保存并重新评估</button>
        </form>}
        <details className="input-history"><summary>任务输入历史 · {data.history.length} 次修订</summary>
          {data.history.length===0?<p className="field-hint">暂无修订</p>:data.history.map(item=><details key={item.revision}><summary>第 {item.revision} 版 · {item.reason}</summary><p>{item.previous.title}</p><BodyContent body={item.previous.objective} projectId={projectId}/><p>验收：{item.previous.acceptanceCriteria}</p><details><summary>此前评估与成果</summary><pre>{JSON.stringify(item.work,null,2)}</pre></details></details>)}
        </details>
        {data.attempts.length>0&&<details><summary>执行尝试与验收反馈</summary>{data.attempts.map(attempt=><section key={attempt.id}><p>{attempt.kind==='assess'?'评估':'执行'} · fence {attempt.fence} · {attempt.state}</p>{attempt.feedback&&<p>{attempt.decision==='accept'?'通过':'拒绝'}：{attempt.feedback}</p>}<pre>{JSON.stringify(attempt.report,null,2)}</pre></section>)}</details>}
      </>}
    </>}
  </section>;
}
