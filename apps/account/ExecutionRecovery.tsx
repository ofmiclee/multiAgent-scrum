import {useCallback,useEffect,useRef,useState} from 'react';
import RequiredMark from './RequiredMark';
import {z} from 'zod';
import {accountRequest,AccountRequestError,denied} from './account-api';

const snapshot=z.object({identityId:z.string(),attempts:z.array(z.object({attemptId:z.uuid(),runnerId:z.uuid(),fence:z.number().int().positive(),deviceName:z.string(),deviceRevoked:z.boolean(),leaseExpired:z.boolean()}).strict()).max(50),hasMore:z.boolean()}).strict();
const receipt=z.object({identityId:z.string(),ok:z.literal(true)}).strict();

export default function ExecutionRecovery({identityId}:{identityId:string}){
  const [data,setData]=useState<z.infer<typeof snapshot>|null>(null),[confirmed,setConfirmed]=useState<Record<string,boolean>>({}),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const alive=useRef(false),sequence=useRef(0),controller=useRef<AbortController|null>(null),working=useRef(false);
  const load=useCallback(async()=>{
    const generation=++sequence.current;controller.current?.abort();const abort=new AbortController();controller.current=abort;
    const result=await accountRequest('/execution-recovery',snapshot,{signal:abort.signal});
    if(!alive.current||abort.signal.aborted||generation!==sequence.current)return;
    if(result.identityId!==identityId)throw new AccountRequestError(403);setData(result);setConfirmed({});
  },[identityId]);
  function failed(error:unknown){if(!alive.current)return;setData(null);setConfirmed({});setNotice(denied(error)?'账号已变化或无权访问，请返回后重新登录。':'无法确认执行隔离状态，请重新读取。');}
  useEffect(()=>{alive.current=true;void load().catch(error=>{if(!(error instanceof DOMException&&error.name==='AbortError'))failed(error);});return()=>{alive.current=false;++sequence.current;controller.current?.abort();};},[load]);
  async function confirm(attempt:z.infer<typeof snapshot>['attempts'][number]){
    if(!confirmed[attempt.attemptId]||working.current)return;working.current=true;setBusy(true);setNotice('');++sequence.current;controller.current?.abort();
    try{
      const result=await accountRequest('/execution-recovery/'+attempt.attemptId+'/confirm-stopped',receipt,{body:{identityId,runnerId:attempt.runnerId,fence:attempt.fence,confirmedStopped:true}});
      if(!alive.current)return;if(result.identityId!==identityId)throw new AccountRequestError(403);
      try{await load();}catch(error){failed(error);if(alive.current&&!denied(error))setNotice('停止确认已保存，请重新读取最新隔离状态。');}
    }catch(error){if(alive.current){
      if(denied(error))failed(error);
      else if(error instanceof AccountRequestError&&error.status===409){setConfirmed({});try{await load();}catch(error){failed(error);}setNotice('该执行当前不能解除隔离，请重新核对设备和执行状态。');}
      else setNotice('确认结果未知。请重试相同执行记录；不要清除本地日志或启动替代进程。');
    }}finally{working.current=false;if(alive.current)setBusy(false);}
  }
  if(data&&data.attempts.length===0&&!notice)return null;
  return <section className="management-block" aria-label="执行隔离核对">
    <div className="section-heading"><h4>待核对的本地执行</h4><button className="secondary-button" disabled={busy} onClick={()=>{setNotice('');void load().catch(failed);}}>读取执行隔离</button></div>
    <p className="field-hint">断线、租约过期或撤销设备，都不能证明进程已经停止。请先到对应设备检查，再确认释放你个人的执行容量。无法检查时请保留隔离。</p>
    <p className="field-hint">确认会记入审计、将该次工作标为失败；不会重跑任务、恢复已撤销设备或删除本地日志。</p>
    {notice&&<p className="notice notice-error" role="alert">{notice}</p>}
    {data===null?<p role="status">隔离状态尚未确认。</p>:data.attempts.length===0?<p className="field-hint">当前没有待核对的执行隔离。</p>:data.attempts.map(attempt=><div className="organization-empty" key={attempt.attemptId}>
      <strong>{attempt.deviceName}</strong><p className="field-hint">{attempt.deviceRevoked?'设备已撤销':'设备或执行租约需要核对'} · 执行尝试 {attempt.attemptId}</p>
      <label className="publication-check"><input type="checkbox" aria-required="true" disabled={busy} checked={confirmed[attempt.attemptId]??false} onChange={event=>setConfirmed(current=>({...current,[attempt.attemptId]:event.target.checked}))}/>我已在这台设备上检查并确认对应进程已停止<RequiredMark/></label>
      <button className="secondary-button" disabled={busy||!confirmed[attempt.attemptId]} onClick={()=>void confirm(attempt)}>确认本地已停止</button>
    </div>)}
    {data?.hasMore&&<p className="field-hint">仅显示最早 50 条隔离记录，请处理后重新读取。</p>}
  </section>;
}
