import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {taskInteractiveConversationResponseSchema,taskMessageReceiptSchema} from '../../packages/domain/task-conversation';
import {accountRequest,AccountRequestError,denied} from './account-api';
import {usePageState,usePageRef} from './page-state';
import {Modal} from './Modal';
import {taskStatusLabel} from './task-status';
import './native-sessions.css';
import './task-conversation.css';

type Conversation=z.infer<typeof taskInteractiveConversationResponseSchema>;
const attemptLabels={assigned:'等待执行',running:'本轮运行中',finished:'本轮已结束',stopped:'本轮已停止'};
const toolLabels={running:'进行中',completed:'已完成',failed:'失败',unconfirmed:'未收到结束状态'};
const messageLabels={queued:'等待送达',delivering:'正在送达',delivered:'Agent 已接收，不代表已采纳',rejected:'未能送达',unknown:'送达未确认，请查看回复后再决定是否重新发送'};
const rejectionLabels={execution_ended:'执行已结束，未能送达',permission_revoked:'发送权限已撤销，未能送达',rejected:'Agent 未接收此消息',unconfirmed:messageLabels.unknown};
const disabledReasons={read_only:'当前账号只有查看权限。',not_running:'当前没有正在运行的执行。',offline:'Runner 已离线，恢复连接后可发送。',unavailable:'当前 Runner 尚未准备好接收消息，请确认已更新并连接。',unsupported:'当前执行器不支持运行中接收消息。',limit:'本轮消息已达到上限。'};
const draftSchema=z.string().max(2000),pendingSchema=z.object({requestId:z.uuid(),attemptId:z.uuid(),body:z.string().min(1).max(2000)}).strict().nullable();

function ConversationComposer({identityId,projectId,taskId,attemptId,canSend,reason,onSent,onDenied}:{identityId:string;projectId:string;taskId:string;attemptId:string;canSend:boolean;reason:string;onSent:()=>void;onDenied:()=>void}){
 const scope='project.'+projectId+'.task.'+taskId+'.attempt.'+attemptId+'.message';
 const [draft,setDraft]=usePageState(scope+'.draft',draftSchema,'',identityId),pending=usePageRef(scope+'.pending',pendingSchema,null,identityId);
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const controller=useRef<AbortController|null>(null),sending=useRef(false);
 useEffect(()=>()=>{controller.current?.abort();},[]);
 async function send(){
  if(sending.current||!canSend)return;
  const request=pending.current??{requestId:crypto.randomUUID(),attemptId,body:draft.trim()};
  if(!request.body||request.attemptId!==attemptId)return;
  pending.current=request;sending.current=true;setBusy(true);setNotice('');
  const waiting=new AbortController();controller.current=waiting;
  try{
   const result=await accountRequest('/projects/'+projectId+'/tasks/'+taskId+'/conversation/messages',taskMessageReceiptSchema,{body:{identityId,...request},signal:AbortSignal.any([waiting.signal,AbortSignal.timeout(10000)])});
   if(waiting.signal.aborted)return;
   if(result.identityId!==identityId||result.projectId!==projectId||result.taskId!==taskId||result.attemptId!==attemptId)throw new AccountRequestError(403);
   pending.current=null;setDraft(current=>current.trim()===request.body?'':current);onSent();
  }catch(error){
   if(waiting.signal.aborted)return;
   if(denied(error)){onDenied();return;}
   if(error instanceof AccountRequestError&&[400,409,422,429].includes(error.status)){
    pending.current=null;setNotice('当前无法发送，草稿已保留。请查看更新后的执行状态。');onSent();
   }else setNotice('提交结果尚未确认，原消息已保留。重试上一条会核对同一次提交。');
  }finally{sending.current=false;if(!waiting.signal.aborted)setBusy(false);}
 }
 const pendingMessage=pending.current;
 return <form className="task-conversation-compose" onSubmit={event=>{event.preventDefault();void send();}}>
  <label htmlFor={'task-message-'+attemptId}>给 Agent 发消息</label>
  <textarea id={'task-message-'+attemptId} maxLength={2000} rows={2} value={draft} disabled={!canSend} aria-describedby={'task-message-hint-'+attemptId} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/>
  {notice&&<p className="notice notice-error" role="alert">{notice}</p>}
  {pendingMessage&&!busy&&!notice&&<p className="field-hint">上一条提交尚未确认，可重试核对；当前草稿会保留。</p>}
  {pendingMessage&&draft.trim()!==pendingMessage.body&&<p className="task-conversation-pending">待核对的消息：{pendingMessage.body}</p>}
  <div className="task-conversation-compose-actions"><p className="field-hint" id={'task-message-hint-'+attemptId}>{canSend?'Enter 换行，Ctrl / ⌘ + Enter 发送。最多 2000 字。':reason}</p><button className="primary-button" disabled={!canSend||busy||(!pendingMessage&&!draft.trim())}>{busy?'提交中…':pendingMessage?'重试上一条':'发送'}</button></div>
 </form>;
}

export default function TaskConversation({identityId,projectId,taskId,onClose}:{identityId:string;projectId:string;taskId:string;onClose:()=>void}){
 const [data,setData]=useState<Conversation|null>(null),[notice,setNotice]=useState(''),[allowed,setAllowed]=useState(true),[retry,setRetry]=useState(0);
 const stream=useRef<HTMLDivElement|null>(null),pinned=useRef(true);
 const current=data?.identityId===identityId&&data.projectId===projectId&&data.taskId===taskId?data:null;
 const attempt=current?.attempt;
 const ended=attempt?.state==='finished'||attempt?.state==='stopped';
 function refuse(){setAllowed(false);setData(null);setNotice('当前账号无权读取此任务对话，或任务已不可用。');}

 useEffect(()=>{setAllowed(true);},[identityId,projectId,taskId]);
 useEffect(()=>{
  if(!allowed)return;
  const controller=new AbortController();let disposed=false,blocked=false,busy=false,timer:number|undefined;
  async function load(){
   if(disposed||blocked||busy||document.hidden)return;
   busy=true;
   try{
    const result=await accountRequest('/projects/'+projectId+'/tasks/'+taskId+'/conversation/messages',taskInteractiveConversationResponseSchema,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
    if(disposed)return;
    if(result.identityId!==identityId||result.projectId!==projectId||result.taskId!==taskId)throw new AccountRequestError(403);
    setData(result);setNotice('');
   }catch(error){
    if(disposed||controller.signal.aborted)return;
    if(denied(error)){blocked=true;refuse();}
    else setNotice('对话暂时无法读取，正在重试。已读取的内容仍保留。');
   }finally{
    busy=false;
    if(!disposed&&!blocked)timer=window.setTimeout(()=>void load(),2000);
   }
  }
  function resume(){if(!document.hidden&&!busy&&!blocked){window.clearTimeout(timer);void load();}}
  void load();document.addEventListener('visibilitychange',resume);
  return()=>{disposed=true;controller.abort();window.clearTimeout(timer);document.removeEventListener('visibilitychange',resume);};
 },[identityId,projectId,taskId,retry,allowed]);

 useEffect(()=>{pinned.current=true;},[attempt?.id]);
 useEffect(()=>{const node=stream.current;if(node&&pinned.current)node.scrollTop=node.scrollHeight;},[attempt?.id,attempt?.snapshot?.revision,current?.messaging.messages]);
 function trackScroll(){const node=stream.current;if(node)pinned.current=node.scrollHeight-node.scrollTop-node.clientHeight<40;}
 const entries=[...(attempt?.snapshot?.entries??[]).map(entry=>({at:entry.at,entry,message:null})),...(current?.messaging.messages??[]).map(message=>({at:Date.parse(message.createdAt),entry:null,message}))].sort((a,b)=>a.at-b.at);
 const canSend=!!attempt&&attempt.state==='running'&&current?.taskStatus==='running'&&current.messaging.canSend&&!notice;
 const reason=notice?'连接暂时不可用，恢复读取后可发送。':current?.messaging.reason?disabledReasons[current.messaging.reason]:disabledReasons.not_running;

 return <Modal title="实时对话" size="wide" className="task-conversation-modal" onClose={onClose}>
  {current&&<div className="task-conversation-heading"><span>任务状态 <span className={'role-label task-state '+current.taskStatus}>{taskStatusLabel[current.taskStatus]}</span></span>{attempt&&<span>{attempt.agentName} · {attemptLabels[attempt.state]}</span>}</div>}
  {notice&&<p className="notice notice-error" role="alert">{notice}{allowed&&<button className="text-button" type="button" onClick={()=>setRetry(value=>value+1)}>重试读取</button>}</p>}
  {!current&&!notice&&<p role="status">正在读取对话…</p>}
  {current&&<>
   {attempt?.state==='running'&&!attempt.live&&<p className="field-hint task-conversation-connection" role="status">连接已中断，不代表执行已停止。恢复连接后继续同步。</p>}
   <div className="task-conversation-stream native-chat-stream" role="log" aria-label="任务执行对话" aria-live="polite" aria-relevant="additions text" tabIndex={0} ref={stream} onScroll={trackScroll}>
    {!attempt?<p className="field-hint">此任务尚未开始执行。</p>:!attempt.snapshot?<p className="field-hint">此轮对话尚未同步；如已开始执行，请确认 Runner 已更新。</p>:attempt.snapshot.truncated?<p className="field-hint">较早内容已截断，以下显示最近同步的对话。</p>:null}
     {entries.map(({entry,message})=>{
      if(message)return <div className="native-chat-message" data-role="user" key={'message:'+message.id}><strong>{message.authorName}</strong><p>{message.body}</p><small className={'task-message-state '+message.state}>{message.state==='rejected'&&message.error?rejectionLabels[message.error]:messageLabels[message.state]}</small></div>;
      if(!entry||!attempt)return null;
      const state=entry.state==='running'&&ended?'unconfirmed':entry.state;
      return entry.kind==='message'?<div className="native-chat-message" data-role="assistant" key={attempt.id+':'+entry.id}><strong>{attempt.agentName}</strong><p>{entry.text}</p></div>:<div className="native-chat-tool" key={attempt.id+':'+entry.id}><span>工具</span><strong>{entry.text}</strong><span className={'task-tool-state '+state}>{toolLabels[state]}</span></div>;
     })}
     {attempt?.snapshot&&entries.length===0&&<p className="field-hint">尚未同步 Agent 回复或工具状态。</p>}
   </div>
   {attempt?.updatedAt&&<p className="task-conversation-updated">最近同步：<time dateTime={attempt.updatedAt}>{new Date(attempt.updatedAt).toLocaleString('zh-CN')}</time></p>}
   {attempt&&<ConversationComposer key={identityId+':'+projectId+':'+taskId+':'+attempt.id} identityId={identityId} projectId={projectId} taskId={taskId} attemptId={attempt.id} canSend={canSend} reason={reason} onSent={()=>setRetry(value=>value+1)} onDenied={refuse}/>}
  </>}
 </Modal>;
}
