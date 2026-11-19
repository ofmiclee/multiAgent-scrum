import {useEffect,useMemo,useRef,useState} from 'react';
import {z} from 'zod';
import {connectLocalRunner} from './local-key';
import './native-sessions.css';
import {parseSessionOutput} from './native-session-output';

const provider=z.enum(['codex','claude','codebuddy','dsh']);
const account=z.object({installed:z.boolean(),status:z.enum(['ready','configured','unavailable','unknown'])}).strict();
const session=z.object({provider,id:z.uuid(),cwd:z.string(),title:z.string(),updatedAt:z.number(),state:z.enum(['idle','active','unknown']),canResume:z.boolean()}).strict();
const listing=z.object({ok:z.literal(true),accounts:z.object({codex:account,claude:account,codebuddy:account,dsh:account}).strict(),projects:z.array(z.string()),sessions:z.array(session)}).strict();
const operation=z.object({ok:z.literal(true),operationId:z.uuid()}).strict();
const progress=z.object({ok:z.literal(true),operationId:z.uuid(),state:z.enum(['running','done','failed','cancelled']),result:z.string(),startedAt:z.number(),output:z.string(),outputTruncated:z.boolean(),
  // Runners older than the thinking feature do not send these; default to a clean empty state.
  thinking:z.string().default(''),thinkingTruncated:z.boolean().default(false)}).strict();
const transcriptMessage=z.object({role:z.enum(['user','assistant']),text:z.string(),timestamp:z.number()}).strict();
const transcript=z.object({ok:z.literal(true),provider,id:z.uuid(),messages:z.array(transcriptMessage),hasMore:z.boolean(),nextCursor:z.string().nullable(),truncated:z.boolean().optional(),unavailableReason:z.string().optional()}).strict();
type Listing=z.infer<typeof listing>;
type Session=z.infer<typeof session>;
type ChatMessage=
  |{kind:'history';role:'user'|'assistant';text:string;timestamp:number}
  |{kind:'prompt';requestId:string;text:string;timestamp:number}
  |{kind:'output';operationId:string;text:string;truncated:boolean}
  |{kind:'result';operationId:string;state:'done'|'failed'|'cancelled';text:string};
const names={codex:'Codex',claude:'Claude Code',codebuddy:'CodeBuddy',dsh:'DSH'};

export default function NativeSessions({identityId,runnerId}:{identityId:string;runnerId:string}){
  const [connection,setConnection]=useState<{base:string;token:string}|null>(null);
  const [data,setData]=useState<Listing|null>(null),[selected,setSelected]=useState<Session|null>(null),[project,setProject]=useState('');
  const [prompt,setPrompt]=useState(''),[running,setRunning]=useState(false),[error,setError]=useState('');
  const [op,setOp]=useState<z.infer<typeof progress>|null>(null);
  const [history,setHistory]=useState<z.infer<typeof transcript>|null>(null);
  const [historyState,setHistoryState]=useState<'loading'|'ready'|'failed'>('ready');
  const [turns,setTurns]=useState<ChatMessage[]>([]);
  const formattedOutput=useMemo(()=>parseSessionOutput(op?.output??'',op?.outputTruncated),[op?.output,op?.outputTruncated]);
  const thinking=op?.outputTruncated&&op.thinking?op.thinking:formattedOutput.filter(block=>block.kind==='thinking').map(block=>block.text).join('\n\n')||op?.thinking||'';
  const pending=useRef<{key:string;requestId:string}|null>(null);
  const stream=useRef<HTMLDivElement|null>(null),pinned=useRef(true);

  useEffect(()=>{
    if(!connection||!op||op.state!=='running')return;
    let disposed=false;
    const timer=window.setInterval(async()=>{
      try{
        const response=await fetch(connection.base+'/native-sessions/operations/'+op.operationId,{headers:{'X-MAS-Config-Token':connection.token},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
        if(!response.ok)throw Error();
        const value=progress.parse(await response.json());if(!disposed){setOp(value);if(value.state!=='running'){setRunning(false);setTurns(current=>[...current,{kind:'result',operationId:value.operationId,state:value.state as 'done'|'failed'|'cancelled',text:value.result}]);}}
      }catch{if(!disposed){setError('会话进度暂时无法读取，正在重试；可在原生客户端检查本轮操作。');}}
    },2000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[connection,op]);

  // Keep the conversation stream pinned to the newest content unless the user scrolled up.
  useEffect(()=>{
    const node=stream.current;
    if(node&&pinned.current)node.scrollTop=node.scrollHeight;
  },[turns,op?.output,thinking,history]);
  function trackScroll(){const node=stream.current;if(!node)return;pinned.current=node.scrollHeight-node.scrollTop-node.clientHeight<40;}

  useEffect(()=>{
    if(!connection||!selected)return;
    let disposed=false;
    setHistory(null);setHistoryState('loading');
    void (async()=>{
      try{
        const response=await fetch(connection.base+'/native-sessions/transcript/'+selected.provider+'/'+selected.id,{headers:{'X-MAS-Config-Token':connection.token},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
        if(!response.ok)throw Error();
        const value=transcript.parse(await response.json());
        if(disposed)return;
        setHistory(value);setHistoryState('ready');
      }catch{if(!disposed)setHistoryState('failed');}
    })();
    return()=>{disposed=true;};
  },[connection,selected]);

  async function loadEarlier(){
    if(!connection||!selected||!history?.nextCursor||historyState!=='ready')return;
    try{
      const response=await fetch(connection.base+'/native-sessions/transcript/'+selected.provider+'/'+selected.id+'/before/'+history.nextCursor,{headers:{'X-MAS-Config-Token':connection.token},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
      if(!response.ok)throw Error();
      const value=transcript.parse(await response.json());
      setHistory(current=>({...value,messages:[...value.messages,...(current?.messages??[])]}));
    }catch{setError('更早的历史消息暂时无法读取。');}
  }

  async function refresh(){
    setRunning(true);setError('');
    try{
      const local=await connectLocalRunner(identityId,runnerId);
      const response=await fetch(local.base+'/native-sessions',{headers:{'X-MAS-Config-Token':local.token},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
      if(!response.ok)throw Error();
      const value=listing.parse(await response.json());setConnection(local);setData(value);
      setSelected(current=>value.sessions.find(item=>item.provider===current?.provider&&item.id===current.id)??null);
    }catch{setConnection(null);setData(null);setError('未能读取本机会话。请在这台电脑打开最新版 Runner 后重试。');}
    finally{setRunning(false);}
  }
  async function send(){
    if(!connection||!selected||!selected.canResume||!prompt.trim()||running)return;
    const text=prompt.trim();
    const key=JSON.stringify({provider:selected.provider,id:selected.id,prompt:text});
    if(pending.current?.key!==key)pending.current={key,requestId:crypto.randomUUID()};
    setRunning(true);setError('');setOp(null);
    const requestId=pending.current.requestId;
    setTurns(current=>[...current,{kind:'prompt',requestId,text,timestamp:Date.now()}]);
    try{
      const response=await fetch(connection.base+'/native-sessions/send',{method:'POST',headers:{'Content-Type':'application/json','X-MAS-Config-Token':connection.token},cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',body:JSON.stringify({provider:selected.provider,id:selected.id,requestId,prompt:text})});
      if(!response.ok)throw Error();
      const value=operation.parse(await response.json());
      pending.current=null;
      setOp({ok:true,operationId:value.operationId,state:'running',result:'',startedAt:Date.now(),output:'',outputTruncated:false,thinking:'',thinkingTruncated:false});setPrompt('');
    }catch{setTurns(current=>{const copy=[...current];const index=copy.map(row=>row.kind).lastIndexOf('prompt');if(index>=0)copy.splice(index,1);return copy;});setError('本机会话未能续接。若原生客户端正在使用这段会话，请先在那里完成当前操作。');setRunning(false);}
  }
  async function cancel(){
    if(!connection||!op||op.state!=='running')return;
    try{const response=await fetch(connection.base+'/native-sessions/operations/'+op.operationId+'/cancel',{method:'POST',headers:{'X-MAS-Config-Token':connection.token},credentials:'omit',referrerPolicy:'no-referrer'});const value=progress.parse(await response.json());setOp(value);setRunning(false);if(value.state!=='running')setTurns(current=>[...current,{kind:'result',operationId:value.operationId,state:value.state as 'done'|'failed'|'cancelled',text:value.result}]);}
    catch{setError('停止状态未能确认，请检查原生客户端。');}
  }
  function selectSession(item:Session){setSelected(item);setOp(null);setTurns([]);}
  const visible=data?.sessions.filter(item=>!project||item.cwd===project)??[];
  const streamMessages:ChatMessage[]=[
    ...(history?.messages.map(message=>({kind:'history' as const,...message}))??[]),
    ...turns.filter(message=>message.kind!=='result'||message.operationId!==op?.operationId),
    ...(op&&(op.output.trim()||thinking)?[{kind:'output' as const,operationId:op.operationId,text:op.output,truncated:op.outputTruncated}]:[]),
    ...turns.filter(message=>message.kind==='result'&&message.operationId===op?.operationId),
  ];
  const sessionStateLabel=(item:Session)=>item.state==='active'?'正在使用':item.canResume?'可续接':item.provider==='dsh'?'暂不可续接':'状态待确认';
  return <div className="native-sessions">
    <div className="native-sessions-heading"><strong>本机 Agent 会话</strong><button className="secondary-button" type="button" disabled={running} onClick={()=>void refresh()}>{data?'刷新':'读取本机会话'}</button></div>
    {error&&<p role="alert" className="notice notice-error">{error}</p>}
    {data&&<>
      <div className="native-session-accounts">{(Object.keys(names) as (keyof typeof names)[]).map(key=>{const value=data.accounts[key];return <span className="role-label" key={key}>{names[key]} {value.status==='ready'?key==='dsh'?'✓ Runner 已配置':'✓ 已登录':value.status==='configured'?'? 本机凭据未验证':value.installed?value.status==='unavailable'?'× 未就绪':'? 待验证':'× 未安装'}</span>;})}</div>
      <label>项目目录<select aria-label="项目目录" value={project} disabled={running} onChange={event=>{setProject(event.target.value);setSelected(null);}}><option value="">全部目录</option>{data.projects.map(path=><option key={path} value={path}>{path}</option>)}</select></label>
      {visible.length===0?<p className="field-hint">没有找到本机历史会话。</p>:<div className="native-session-split">
        <div className="native-session-picker" role="listbox" aria-label="本机会话列表" aria-orientation="vertical">
          {visible.map(item=><button className="native-session-item" type="button" role="option" disabled={running&&!(selected?.id===item.id&&selected.provider===item.provider)} key={item.provider+item.id} aria-selected={selected?.id===item.id&&selected.provider===item.provider} onClick={()=>selectSession(item)}>
            <span><strong>{names[item.provider]}</strong> · {item.title}</span><small>{new Date(item.updatedAt).toLocaleString()} · {sessionStateLabel(item)}</small>
          </button>)}
        </div>
        <div className="native-session-chat">
          {!selected?<div className="native-chat-empty"><p>从左侧选择一个会话，查看历史并续接。</p><p className="field-hint">会话留在本机；续接会在原生 CLI 中产生新一轮操作。</p></div>:<>
            <div className="native-chat-stream" role="log" aria-live="polite" ref={stream} onScroll={trackScroll}>
              {historyState==='loading'&&<p className="field-hint">正在读取历史消息…</p>}
              {historyState==='failed'&&<p className="field-hint">历史消息暂时无法读取。<button className="secondary-button" type="button" onClick={()=>selectSession(selected)}>重试</button></p>}
              {historyState==='ready'&&history&&history.messages.length===0&&history.unavailableReason&&<p className="field-hint">这个客户端的历史消息暂不可读，以下为从本页发起的对话。</p>}
              {history?.hasMore&&historyState==='ready'&&<p className="native-chat-earlier"><button className="secondary-button" type="button" onClick={()=>void loadEarlier()}>加载更早消息</button></p>}
              {streamMessages.map((message,index)=>{
                if(message.kind==='output')return <div className="native-chat-output" key={'output:'+message.operationId}>
                  {thinking&&<details className="native-chat-thinking" open={op?.state==='running'}>
                    <summary>思考过程{op?.thinkingTruncated||message.truncated?'（开头可能已截断）':''}</summary>
                    <div className="native-chat-readable">{thinking}</div>
                  </details>}
                  {formattedOutput.filter(block=>block.kind!=='thinking'&&!(block.kind==='text'&&op?.state==='done'&&block.text.trim()===op.result.trim())).map((block,index)=>block.kind==='tool'
                    ?<div className="native-chat-tool" key={index}><span>工具调用</span><strong>{block.text}</strong>{block.detail&&<code>{block.detail}</code>}</div>
                    :<p className="native-chat-readable" key={index}>{block.text}</p>)}
                  {message.text&&<details className="native-chat-raw"><summary>原始日志{message.truncated?'（开头已截断）':''}</summary><pre>{message.text}</pre></details>}
                </div>;
                if(message.kind==='result')return <div className={'native-chat-message'+(message.state==='done'?'':' native-chat-system')} key={'result:'+message.operationId} data-role={message.state==='done'?'assistant':'system'}>
                  <strong>{message.state==='done'?'回复':message.state==='failed'?'执行失败':'已停止'}</strong><p>{message.text}</p></div>;
                const role=message.kind==='history'?message.role:'user';
                return <div className="native-chat-message" key={message.kind+':'+message.timestamp+':'+index} data-role={role}>
                  <strong>{role==='user'?'我':names[selected.provider]}</strong><p>{message.text}</p>
                  {message.kind==='history'&&<small>{new Date(message.timestamp).toLocaleString()}</small>}
                </div>;
              })}
              {op?.state==='running'&&<p className="native-chat-running" role="status">正在执行…（已运行 {Math.max(1,Math.round((Date.now()-op.startedAt)/1000))} 秒）</p>}
              {streamMessages.length===0&&historyState==='ready'&&<p className="field-hint">会话留在本机。续接会在原生 CLI 中产生新一轮操作；运行中的会话请在原客户端继续。</p>}
            </div>
            <div className="native-session-compose">
              <textarea aria-label="发送给本机会话" value={prompt} maxLength={8000} disabled={running||!selected.canResume} onChange={event=>setPrompt(event.target.value)} placeholder={selected.canResume?'输入下一轮指令':'当前会话不可并行续接'}/>
              <div className="form-actions"><button className="primary-button" type="button" disabled={running||!selected.canResume||!prompt.trim()} onClick={()=>void send()}>续接会话</button>{op?.state==='running'&&<button className="secondary-button" type="button" onClick={()=>void cancel()}>停止本轮</button>}</div>
            </div>
          </>}
        </div>
      </div>}
    </>}
  </div>;
}
