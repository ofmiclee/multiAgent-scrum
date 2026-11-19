import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {usePageRef} from './page-state';

const capability=z.object({identityId:z.string(),taskId:z.uuid(),revision:z.number().int().min(1).max(4),attemptId:z.uuid().nullable(),retryCount:z.number().int().min(0).max(3),retryLimit:z.literal(3),canRetry:z.boolean(),reason:z.enum(['owner_required','unsettled','not_failed','attempt_not_stopped','retry_limit','assessment_required']).nullable()}).strict();
const retryInput=z.object({identityId:z.string(),requestId:z.uuid(),expectedRevision:z.number().int().min(1).max(4),expectedAttemptId:z.uuid()}).strict();
const receipt=z.object({identityId:z.string(),ok:z.literal(true)}).strict();
const reasons:Record<NonNullable<z.infer<typeof capability>['reason']>,string>={
  owner_required:'仅项目所有者可以重试任务。',
  unsettled:'旧执行尚未确认停止。请执行成员先在“管理 Runner”核对本地执行，再刷新任务。',
  not_failed:'任务状态已变化，当前不需要重试。',
  attempt_not_stopped:'本次执行不符合直接重试条件。若需调整任务，请使用“修订与历史”。',
  retry_limit:'当前输入版本已重试 3 次，不能继续直接重试。请核对原因，必要时通过“修订与历史”调整任务。',
  assessment_required:'当前评估尚未通过或需要更新，请先处理评估。',
};

export default function TaskRetry({identityId,projectId,taskId,status,readOnly,refreshVersion,onRetried}:{identityId:string;projectId:string;taskId:string;status:string;readOnly:boolean;refreshVersion:number;onRetried:()=>Promise<void>}){
  const pending=usePageRef('project.'+projectId+'.task.'+taskId+'.retry-pending',retryInput.nullable(),null,identityId);
  const [data,setData]=useState<z.infer<typeof capability>|null>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reading,setReading]=useState(false),[allowed,setAllowed]=useState(true);
  const alive=useRef(false),generation=useRef(0),controller=useRef<AbortController|null>(null),working=useRef(false);
  const path='/projects/'+projectId+'/tasks/'+taskId+'/retry';
  const visible=status==='failed'||pending.current!==null;
  const load=useCallback(async()=>{
    const current=++generation.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;setReading(true);setData(null);
    try{
      const result=await accountRequest(path,capability,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10000)])});
      if(!alive.current||abort.signal.aborted||current!==generation.current)return;
      if(result.identityId!==identityId||result.taskId!==taskId)throw new AccountRequestError(403);
      setData(result);setAllowed(true);
    }catch(error){
      if(!alive.current||abort.signal.aborted||current!==generation.current)return;
      throw error;
    }finally{if(alive.current&&current===generation.current)setReading(false);}
  },[path,identityId,taskId]);
  function readFailed(error:unknown){
    if(!alive.current||error instanceof DOMException&&error.name==='AbortError')return;
    setData(null);setAllowed(!denied(error));setNotice(denied(error)?'当前账号无权读取此任务的重试状态。':'重试条件暂时无法确认，请重新读取。');
  }
  useEffect(()=>{
    alive.current=true;setNotice('');if(visible)void load().catch(readFailed);
    return()=>{alive.current=false;++generation.current;controller.current?.abort();};
  },[load,visible,refreshVersion]);
  async function retry(confirmPending=false){
    if(working.current||reading||readOnly||!allowed||!data||data.reason==='owner_required')return;
    if(confirmPending?!pending.current:pending.current||!data.canRetry||!data.attemptId)return;
    const input=retryInput.parse(confirmPending?pending.current:{identityId,requestId:crypto.randomUUID(),expectedRevision:data.revision,expectedAttemptId:data.attemptId});
    if(input.identityId!==identityId)return;
    pending.current=input;working.current=true;setBusy(true);setNotice('');const current=++generation.current;controller.current?.abort();
    const waiting=new AbortController();controller.current=waiting;
    try{
      const result=await accountRequest(path,receipt,{body:input,signal:AbortSignal.any([waiting.signal,AbortSignal.timeout(10000)])});
      if(!alive.current||current!==generation.current)return;
      if(result.identityId!==identityId)throw new AccountRequestError(403);
      pending.current=null;setData(null);
      try{await onRetried();if(alive.current)setNotice('已提交重试，等待自动分配。');}
      catch{if(alive.current)setNotice('重试已提交，但最新状态暂时无法读取，请刷新执行状态。');}
    }catch(error){if(alive.current&&current===generation.current){
      if(denied(error)){setAllowed(false);setData(null);setNotice('当前账号无权重试此任务，已有任务草稿仍保留。');}
      else if(error instanceof AccountRequestError&&[400,409].includes(error.status)){
        pending.current=null;
        try{await load();}catch(error){readFailed(error);return;}
        if(alive.current)setNotice('任务版本或执行状态已变化，请核对最新状态后再操作。');
      }else setNotice('重试结果尚未确认。可核对上次请求结果，不会重复发起一轮执行。');
    }}finally{working.current=false;if(alive.current)setBusy(false);}
  }
  if(!visible)return null;
  return <section className="task-retry" aria-label="重试执行">
    <h5>重试执行</h5>
    {notice&&<p role="status">{notice}</p>}
    {reading?<p className="field-hint" role="status">正在确认重试条件…</p>:data?<>
      {pending.current?<p className="field-hint">上次重试请求尚未确认。核对时沿用原请求，不会修改任务内容。</p>:data.canRetry?<p className="field-hint">保留当前输入版本和已批准评估，创建新的执行尝试，等待自动分配。此前记录和反馈会保留，执行后仍需验收。</p>:data.reason&&<p className="field-hint">{reasons[data.reason]}</p>}
      <p className="field-hint">当前输入第 {data.revision} 版 · 已重试 {data.retryCount} / {data.retryLimit} 次</p>
      {!readOnly&&allowed&&data.reason!=='owner_required'&&(pending.current||data.canRetry&&data.attemptId)&&<button type="button" className="primary-button" disabled={busy||reading} onClick={()=>void retry(!!pending.current)}>{busy?'正在提交…':pending.current?'核对上次重试结果':'重试本次任务'}</button>}
    </>:null}
    {!reading&&!busy&&(!data||!data.canRetry)&&<button type="button" className="text-button" onClick={()=>{setNotice('');void load().catch(readFailed);}}>重新读取重试条件</button>}
  </section>;
}
