import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError} from './account-api';
import HelpTip from './HelpTip';
import RunnerDownload from './RunnerDownload';

const started=z.object({identityId:z.string(),id:z.uuid(),ticket:z.string().regex(/^[a-f0-9]{64}$/),expiresAt:z.number(),verificationCode:z.string().min(1).max(32)}).strict();
const snapshot=z.object({identityId:z.string(),id:z.uuid(),expiresAt:z.number(),verificationCode:z.string().min(1).max(32),status:z.enum(['waiting','confirm','connected','expired']),device:z.object({runnerId:z.uuid(),name:z.string(),online:z.boolean()}).strict().nullable()}).strict();
type Device={runnerId:string;name:string;online:boolean;revoked:boolean};
type Props={identityId:string;devices:Device[]|null;disabled:boolean;onConnected:(runnerId?:string)=>Promise<void>;resumeId?:string|null;onStarted?:(intentId:string)=>void};
type Intent=Omit<z.infer<typeof started>,'ticket'>&{ticket?:string};

export default function ConnectDevice({identityId,devices,disabled,onConnected,resumeId,onStarted}:Props){
  const storageKey='mas.last-device.'+identityId;
  const [remembered,setRemembered]=useState<string|null>(()=>{
    try{const value=localStorage.getItem(storageKey);return z.uuid().safeParse(value).success?value:null;}catch{return null;}
  });
  const [intent,setIntent]=useState<Intent|null>(()=>resumeId?{id:resumeId,identityId,expiresAt:Date.now()+300_000,verificationCode:''}:null),[result,setResult]=useState<z.infer<typeof snapshot>|null>(null);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[matched,setMatched]=useState<string|null>(null);
  const alive=useRef(true),generation=useRef(0),active=useRef<AbortController|null>(null),notified=useRef('');
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;++generation.current;active.current?.abort();};},[]);
  const rememberedDevice=devices?.find(d=>d.runnerId===(matched??remembered)&&!d.revoked);
  const connected=!!rememberedDevice?.online&&!notice&&(!result||(result.status==='connected'&&result.device?.runnerId===rememberedDevice.runnerId&&result.device.online));
  const link=intent?.ticket?'mas-runner://connect?'+new URLSearchParams({server:window.location.origin,ticket:intent.ticket}):null;
  const canOpen=!!link&&!connected&&result?.status!=='expired'&&!notice;
  const confirming=result?.status==='confirm'&&!!result.device;
  function failure(error:unknown){
    setResult(null);
    setMatched(null);
    setNotice(error instanceof AccountRequestError&&[401,403,404].includes(error.status)?'连接已失效，请重新登录或重新连接。':'连接状态暂时无法确认，请重试。');
  }
  async function accept(value:z.infer<typeof snapshot>){
    if(value.identityId!==identityId)throw new AccountRequestError(403);
    setIntent(current=>current?.id===value.id&&current.expiresAt!==value.expiresAt?{...current,expiresAt:value.expiresAt,verificationCode:value.verificationCode}:current);
    setResult(value);
    if(value.status==='connected'&&value.device){
      setMatched(resumeId?null:value.device.runnerId);setRemembered(value.device.runnerId);
      if(!onStarted&&window.location.hash==='#runner-connect='+value.id)window.history.replaceState(null,'',window.location.pathname+window.location.search);
      try{localStorage.setItem(storageKey,value.device.runnerId);}catch{/* The hint is optional, never an authorization credential. */}
      const marker=value.device.runnerId+':'+value.device.online;
      if(notified.current!==marker){const firstMatch=!notified.current;notified.current=marker;await onConnected(firstMatch?value.device.runnerId:undefined);}
    }
  }
  useEffect(()=>{
    if(!intent)return;
    const op=generation.current,controller=new AbortController();let timer:number|undefined;
    const poll=async()=>{
      if(Date.now()>=intent.expiresAt){
        setResult(current=>current?.status==='connected'?current:{identityId,id:intent.id,expiresAt:intent.expiresAt,verificationCode:intent.verificationCode,status:'expired',device:null});return;
      }
      try{
        const value=await accountRequest('/device-launch/'+intent.id,snapshot,{signal:controller.signal});
        if(!alive.current||controller.signal.aborted||op!==generation.current)return;
        await accept(value);
        if(value.status==='expired')return;
      }catch(error){if(!controller.signal.aborted&&alive.current&&op===generation.current)failure(error);return;}
      if(!controller.signal.aborted&&op===generation.current)timer=window.setTimeout(()=>void poll(),2000);
    };
    void poll();return()=>{controller.abort();window.clearTimeout(timer);};
  },[intent,identityId,onConnected]);
  async function start(){
    if(busy||disabled||connected)return;
    const op=++generation.current;active.current?.abort();const controller=new AbortController();active.current=controller;
    setBusy(true);setIntent(null);setResult(null);setMatched(null);setNotice('');notified.current='';
    try{
      const value=await accountRequest('/device-launch',started,{body:{identityId},signal:controller.signal});
      if(!alive.current||op!==generation.current)return;
      if(value.identityId!==identityId)throw new AccountRequestError(403);
      setIntent(value);
      onStarted?.(value.id);
      window.history.replaceState(null,'',window.location.pathname+window.location.search+'#runner-connect='+value.id);
      // Browsers can require another user gesture; an explicit link remains visible.
      window.location.assign('mas-runner://connect?'+new URLSearchParams({server:window.location.origin,ticket:value.ticket}));
    }catch(error){if(alive.current&&op===generation.current&&!controller.signal.aborted)failure(error);}
    finally{if(alive.current&&op===generation.current)setBusy(false);}
  }
  async function confirm(){
    if(!intent||busy||disabled)return;
    const op=++generation.current;active.current?.abort();const controller=new AbortController();active.current=controller;
    setBusy(true);setNotice('');
    try{
      const value=await accountRequest('/device-launch/'+intent.id+'/confirm',snapshot,{body:{identityId},signal:controller.signal});
      if(alive.current&&op===generation.current){
        await accept(value);
        if(alive.current&&op===generation.current&&value.status==='connected')setIntent(current=>current?.id===intent.id?{...current}:current);
      }
    }catch(error){if(alive.current&&op===generation.current&&!controller.signal.aborted)failure(error);}
    finally{if(alive.current&&op===generation.current)setBusy(false);}
  }
  return <div className="device-connect" aria-label="连接本机 Runner">
    <div className="heading-with-tip"><h2>连接本机</h2><HelpTip label="连接电脑说明">下载并打开 Runner，再连接这台电脑。浏览器不能判断它是否已安装；已安装时可直接打开。在线只表示电脑已连接；执行权限在 Agent 管理中设置。</HelpTip></div>
    <p className="field-hint">{connected?'上次连接的设备在线，连接状态会自动更新。':'已安装 Runner？打开应用后连接到你的账号。'}</p>
    {notice&&<p className="notice notice-error" role="alert">{notice}</p>}
    {result?.status==='confirm'&&result.device?<div className="device-match">
      <strong>{result.device.name}</strong><p className="field-hint">核对 Runner 中的校验码：</p><strong className="pairing-code">{result.verificationCode}</strong>
      <p className="field-hint">仅绑定设备，不启用 Agent。</p>
      <button type="button" className="primary-button" aria-busy={busy} disabled={busy||disabled} onClick={()=>void confirm()}>{busy?'绑定中…':'绑定到我的账号'}</button>
    </div>:result?.status==='expired'?<p role="status">连接请求已过期，请重新连接。</p>:intent&&result?.status!=='connected'&&!notice?<p role="status" className="field-hint">等待 Runner 响应…</p>:null}
    <div className="form-actions">
      {canOpen&&!confirming&&<a className="primary-button" href={link!}>打开 Runner</a>}
      <button type="button" className={confirming||canOpen?'secondary-button':'primary-button'} disabled={busy||disabled||connected} onClick={()=>void start()}>{busy?'连接中…':connected?'已连接':confirming||canOpen?'重新连接':'连接本机'}</button>
    </div>
    <details className="runner-install" open={devices!==null&&devices.length===0}>
      <summary>安装 Runner</summary>
      <div className="heading-with-tip"><h3>还没有安装？</h3><HelpTip label="安装 Runner 说明">在 Apple 芯片 Mac 上打开 .dmg，将 Runner 拖入“应用程序”。安装后点击“连接本机”，允许浏览器打开 Runner。</HelpTip></div>
      <RunnerDownload/>
      <p className="field-hint">仅支持 Apple 芯片 Mac。安装包尚未签名或公证。</p>
    </details>
  </div>;
}
