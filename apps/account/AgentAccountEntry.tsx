import {useCallback,useEffect,useState} from 'react';
import {z} from 'zod';
import {Modal} from './Modal';
import {accountRequest,AccountRequestError} from './account-api';
import {saveLocalApiKey} from './local-key';

const listing=z.object({identityId:z.string(),credentials:z.array(z.object({runnerId:z.uuid(),id:z.union([z.literal('legacy'),z.uuid()]),profile:z.enum(['codex-code','dsh-text']),kind:z.enum(['subscription','api-key']),label:z.string(),ready:z.boolean()}).strict())}).strict();
export default function AgentAccountEntry({identityId,runnerId,profile,disabled,onReturn}:{identityId:string;runnerId:string;profile:'codex-code'|'dsh-text';disabled:boolean;onReturn:()=>Promise<void>}){
  const [method,setMethod]=useState<'subscription'|'apiKey'|null>(null),[opened,setOpened]=useState(false),[failed,setFailed]=useState(false);
  const [hasSubscription,setHasSubscription]=useState<boolean|null>(null),[label,setLabel]=useState(''),[apiKey,setApiKey]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const refreshAccounts=useCallback(async()=>{
    const result=await accountRequest('/runner-credentials',listing,{expectedIdentity:identityId});
    if(result.identityId!==identityId)throw Error('Identity changed');
    setFailed(false);
    setHasSubscription(result.credentials.some(item=>item.runnerId===runnerId&&item.profile==='codex-code'&&item.kind==='subscription'));
  },[identityId,runnerId]);
  useEffect(()=>{void refreshAccounts().catch(()=>setFailed(true));},[refreshAccounts]);
  useEffect(()=>{
    if(!opened)return;
    const refresh=()=>{void Promise.all([onReturn(),refreshAccounts()]).catch(()=>setFailed(true));};
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[opened,onReturn,refreshAccounts]);
  const href='mas-runner://account?'+new URLSearchParams({server:window.location.origin,runnerId,provider:profile});
  const title=method==='subscription'?'订阅账号登录':`新增 ${profile==='codex-code'?'Codex':'DSH'} API Key`;
  async function save(){
    if(saving)return;
    setSaving(true);setError('');
    try{
      await saveLocalApiKey(identityId,runnerId,profile,label.trim()||`${profile==='codex-code'?'Codex':'DSH'} API Key`,apiKey.trim());
      setApiKey('');setLabel('');setMethod(null);setOpened(true);
      await Promise.all([onReturn(),refreshAccounts()]);
    }catch(cause){setError(cause instanceof AccountRequestError?([401,403].includes(cause.status)?'登录状态已变化，请重新登录后重试。':'无法读取 Runner 配置，请稍后重试。'):cause instanceof TypeError?'无法连接本机 Runner，请确认正在同一台 Mac 上操作，并已打开 Runner。':cause instanceof Error?cause.message:'本机配置失败，请重试。');}
    finally{setSaving(false);}
  }
  return <div>
    <div className="form-actions">
      {profile==='codex-code'&&hasSubscription===false&&<button type="button" className="secondary-button" disabled={disabled||!runnerId} onClick={()=>setMethod('subscription')}>订阅账号登录</button>}
      <button type="button" className="secondary-button" disabled={disabled||!runnerId} onClick={()=>{setError('');setMethod('apiKey');}}>新增 API Key</button>
    </div>
    {method&&<Modal title={title} size="compact" onClose={()=>{if(!saving){setApiKey('');setMethod(null);}}}>
      {method==='subscription'?<><p className="app-modal-confirm-text">在关联的 Mac 上打开 Runner，完成 Codex 订阅账号授权。</p>
        <footer className="app-modal-actions"><button type="button" className="secondary-button" onClick={()=>setMethod(null)}>关闭</button><a className="primary-button" href={href} onClick={()=>{setOpened(true);setMethod(null);}}>打开 Runner</a></footer></>
      :<form onSubmit={event=>{event.preventDefault();void save();}}>
        <p className="app-modal-confirm-text">请在 Runner 所在的 Mac 打开此页面。密钥仅保存到本机 Runner，不经过云端服务。</p>
        <div className="form-field"><div className="field-label"><label htmlFor="agent-key-label">账号名称</label></div><input id="agent-key-label" value={label} maxLength={80} autoComplete="off" placeholder={`${profile==='codex-code'?'Codex':'DSH'} API Key`} onChange={event=>setLabel(event.target.value)}/></div>
        <div className="form-field"><div className="field-label"><label htmlFor="agent-api-key">API Key</label></div><input id="agent-api-key" type="password" required value={apiKey} maxLength={1024} autoComplete="off" spellCheck={false} onChange={event=>setApiKey(event.target.value)}/></div>
        {error&&<p className="notice notice-error" role="alert">{error}</p>}
        <footer className="app-modal-actions"><button type="button" className="secondary-button" disabled={saving} onClick={()=>{setApiKey('');setMethod(null);}}>取消</button><button type="submit" className="primary-button" disabled={saving||!apiKey.trim()}>{saving?'保存中…':'保存到本机'}</button></footer>
      </form>}
    </Modal>}
    {opened&&<button type="button" className="text-button" onClick={()=>void Promise.all([onReturn(),refreshAccounts()]).catch(()=>setFailed(true))}>刷新账号列表</button>}
    {failed&&<p className="notice notice-error" role="alert">状态读取失败，请刷新网页。</p>}
  </div>;
}
