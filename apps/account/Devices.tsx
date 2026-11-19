import RequiredMark from './RequiredMark';
import HelpTip from './HelpTip';
import {Monitor} from 'lucide-react';
import './devices.css';
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {z} from 'zod';
import {accountRequest,AccountRequestError} from './account-api';
import ConnectDevice from './ConnectDevice';
import NativeSessions from './NativeSessions';

const deviceSchema=z.object({runnerId:z.uuid(),name:z.string(),online:z.boolean(),lastSeen:z.number().nullable(),revoked:z.boolean(),executionReady:z.literal(false)}).strict();
export const deviceListingSchema=z.object({identityId:z.string(),devices:z.array(deviceSchema)}).strict();
const mutationSchema=z.object({identityId:z.string(),device:deviceSchema}).strict();
type Device=z.infer<typeof deviceSchema>;

export default function Devices({identityId,name,onBack,resumeId}:{identityId:string;name:string;onBack:()=>void;resumeId?:string|null}){
  const [devices,setDevices]=useState<Device[]|null>(null),[code,setCode]=useState(''),[runnerId,setRunnerId]=useState('');
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState<string|null>(null),[observed,setObserved]=useState<number|null>(null);
  const generation=useRef(0),mounted=useRef(false),controller=useRef<AbortController|null>(null),working=useRef(false);
  const load=useCallback(async()=>{
    const op=++generation.current;controller.current?.abort();const active=new AbortController();controller.current=active;
    try{
      const result=await accountRequest('/devices',deviceListingSchema,{signal:active.signal});
      if(!mounted.current||op!==generation.current)return;
      if(result.identityId!==identityId)throw new AccountRequestError(403);
      setDevices(result.devices);setObserved(Date.now());setNotice(null);
    }catch(error){if(mounted.current&&op===generation.current&&!active.signal.aborted){
      // Do not leave stale green badges visible after access/network failure.
      setDevices(null);setObserved(null);
      setNotice(error instanceof AccountRequestError&&[401,403].includes(error.status)?'账号已变化或无权访问，请返回并重新登录。':'设备状态暂时无法确认，请重试。');
    }}
  },[identityId]);
  useEffect(()=>{
    mounted.current=true;void load();
    const timer=window.setInterval(()=>{if(!working.current)void load();},10_000);
    return()=>{mounted.current=false;++generation.current;controller.current?.abort();window.clearInterval(timer);};
  },[load]);
  async function mutate(path:string,body:object){
    if(working.current)return;working.current=true;setBusy(true);setNotice(null);
    ++generation.current;controller.current?.abort();
    try{
      const result=await accountRequest(path,mutationSchema,{body:{identityId,...body}});
      if(!mounted.current)return;
      if(result.identityId!==identityId)throw new AccountRequestError(403);
      setCode('');setRunnerId('');await load();
    }catch(error){if(mounted.current){
      if(error instanceof AccountRequestError&&[401,403].includes(error.status)){setDevices(null);setObserved(null);}
      setNotice(error instanceof AccountRequestError&&[401,403].includes(error.status)?'账号已变化或无权操作，请返回并重新登录。':
        error instanceof AccountRequestError&&error.status===404?'配对码已过期、信息不匹配，或设备不属于当前账号。请检查后重试。':'操作结果尚未确认，可使用相同信息重试；不会重复绑定。');
    }}finally{working.current=false;if(mounted.current)setBusy(false);}
  }
  function bind(event:FormEvent){
    event.preventDefault();if(busy)return;
    if(!z.uuid().safeParse(runnerId.trim()).success||!/^[A-F0-9]{16}$/.test(code.trim().toUpperCase())){
      setNotice('请输入 Runner 显示的完整 ID 和 16 位配对码。');return;
    }
    void mutate('/devices/bind',{runnerId:runnerId.trim(),code:code.trim().toUpperCase()});
  }
  return <section className="devices-page" aria-label="管理 Runner">
    <div className="workspace-page-heading"><div><h1>管理 Runner</h1><span>连接电脑，管理本机会话</span></div></div>
    {notice&&<div className="notice notice-error" role="alert">{notice}</div>}
    <div className="devices-layout">
      <aside className="devices-setup" aria-label="连接与安装">
        <ConnectDevice key={identityId} identityId={identityId} devices={devices} disabled={busy} onConnected={load} resumeId={resumeId}/>
    <details className="setup-help devices-pairing"><summary>手动配对</summary><form className="story-form" aria-label="绑定个人设备" aria-busy={busy} onSubmit={bind}>
      <label htmlFor="runner-id">Runner ID<RequiredMark/></label><input id="runner-id" required maxLength={36} value={runnerId} disabled={busy} onChange={e=>setRunnerId(e.target.value)} autoComplete="off" spellCheck={false}/>
      <div className="field-label"><label htmlFor="runner-pair-code">一次性配对码<RequiredMark/></label><HelpTip label="配对码说明">使用本人 Runner 显示的信息，配对码 5 分钟有效。</HelpTip></div><input id="runner-pair-code" required maxLength={16} value={code} disabled={busy} onChange={e=>setCode(e.target.value)} autoComplete="off" spellCheck={false}/>

      <p className="field-hint">核对本机显示的信息后，绑定到 {name} 的个人账号。配对码 5 分钟有效。</p>
      <div className="form-actions"><button type="submit" className="primary-button" disabled={busy}>{busy?'处理中…':'绑定到我的账号'}</button></div>
    </form></details>
      </aside>
      <section className="devices-list" aria-labelledby="devices-list-title">
        <div className="devices-section-heading"><h2 id="devices-list-title">我的设备{devices&&<span className="devices-count">{devices.length}</span>}</h2>
          {observed&&<span className="devices-updated">更新于 {new Date(observed).toLocaleTimeString()}</span>}
        </div>
        {devices===null?<div className="devices-empty"><h3>{notice?'无法获取设备状态':'正在获取设备状态…'}</h3><p role="status">{notice?'连接恢复后可重新加载。':'正在确认你的设备连接情况。'}</p>{notice&&<button className="secondary-button" disabled={busy} onClick={()=>void load()}>重新加载</button>}</div>:devices.length===0?<div className="devices-empty"><Monitor size={28} aria-hidden="true"/><h3>连接你的第一台电脑</h3><p>安装并打开 Runner，然后选择“连接本机”。<br/>绑定后，可在这里查看设备状态和本机会话。</p></div>:
          devices.map(device=><article className="runner-device" key={device.runnerId} aria-label={device.name}>
            <header className="runner-device-heading"><Monitor size={20} aria-hidden="true"/><h3>{device.name}</h3><span className="agent-status" data-state={device.revoked?'warning':device.online?'positive':undefined}>{device.revoked?'已撤销':device.online?'在线':'离线'}</span></header>
            <p className="runner-device-caption">{device.revoked?'此设备的连接授权已撤销。':device.online?'设备已连接，会话仅可在这台电脑上读取。':'设备当前离线，请在对应电脑上打开 Runner。'}</p>
            {!device.revoked&&<NativeSessions identityId={identityId} runnerId={device.runnerId}/>}
            <details className="runner-device-details"><summary>{device.revoked?'设备详情':'设备详情与解绑'}</summary>
              <p className="device-id">Runner ID：{device.runnerId}</p>
              {device.lastSeen!==null&&<p className="field-hint">最近在线：{new Date(device.lastSeen).toLocaleString()}</p>}
              {device.revoked?<p className="field-hint">若设备仍在你手中，选择“连接本机”可用同一账号重新授权。</p>:<div className="runner-device-revoke">
                <p className="field-hint">撤销后将拒绝此设备继续连接；这不代表本地进程已经停止。</p>
                <button type="button" className="secondary-button" disabled={busy} onClick={()=>void mutate('/devices/'+device.runnerId+'/revoke',{})}>撤销设备绑定</button>
              </div>}
            </details>
          </article>)}
        <p className="devices-permission-note">在线仅表示设备已连接。执行权限请在“我的 Agent”中配置。</p>
      </section>

    </div>
  </section>;
}
