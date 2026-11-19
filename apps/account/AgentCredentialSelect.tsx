import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {z} from 'zod';
import {accountRequest} from './account-api';
import AgentAccountEntry from './AgentAccountEntry';

const credential=z.object({runnerId:z.uuid(),id:z.union([z.literal('legacy'),z.uuid()]),profile:z.enum(['codex-code','dsh-text']),kind:z.enum(['subscription','api-key']),label:z.string(),ready:z.boolean()}).strict();
const listing=z.object({identityId:z.string(),credentials:z.array(credential)}).strict();
export type AgentCredential=z.infer<typeof credential>;

export default function AgentCredentialSelect({identityId,runnerId,profile,value,onChange,disabled,onRefresh,showAccountActions=true}:{identityId:string;runnerId:string;profile:'codex-code'|'dsh-text';value:string;onChange:(id:string)=>void;disabled:boolean;onRefresh?:()=>Promise<void>;showAccountActions?:boolean}){
  const id=useId(),[items,setItems]=useState<AgentCredential[]|null>(null),[failed,setFailed]=useState(false);
  const active=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{
    active.current?.abort();const controller=new AbortController();active.current=controller;
    setFailed(false);
    if(!runnerId){setItems([]);return;}
    try{
      const result=await accountRequest('/runner-credentials',listing,{signal:controller.signal});
      if(controller.signal.aborted)return;
      if(result.identityId!==identityId)throw Error('Identity changed');
      setItems(result.credentials.filter(item=>item.runnerId===runnerId&&item.profile===profile));
    }catch(error){if(controller.signal.aborted)return;setItems(null);setFailed(true);throw error;}
  },[identityId,runnerId,profile]);
  useEffect(()=>{
    setItems(null);
    const refresh=()=>{void load().catch(()=>{});};
    refresh();const timer=window.setInterval(refresh,10_000);window.addEventListener('focus',refresh);
    return()=>{active.current?.abort();window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[load]);
  useEffect(()=>{if(disabled||value||items?.length!==1)return;onChange(items[0].id);},[items,value,onChange,disabled]);
  const refresh=async()=>{await load();await onRefresh?.();};
  const loading=!!runnerId&&items===null&&!failed;
  return <div className="agent-credential-select" aria-busy={loading}>
    <div className="field-label"><label htmlFor={id}>使用账号</label></div>
    <select id={id} required disabled={disabled||!runnerId} value={items?.some(item=>item.id===value)?value:''} onChange={event=>onChange(event.target.value)}>
      <option value="">{!runnerId?'请先选择 Runner':loading?'正在读取账号…':failed?'账号列表读取失败':items?.length?'选择已配置的账号':'暂无可用账号'}</option>
      {items?.map(item=><option key={item.id} value={item.id}>{item.kind==='subscription'?'订阅':'API Key'} · {item.label}{item.ready?'':' · 未就绪'}</option>)}
    </select>
    {value&&items?.find(item=>item.id===value)?.ready===false&&<p className="field-hint">此凭据当前未就绪；请检查本机 Runner。</p>}
    {failed&&<p className="notice notice-error" role="alert">账号列表读取失败。<button type="button" className="text-button" disabled={disabled} onClick={()=>void load().catch(()=>{})}>重新加载账号</button></p>}
    {showAccountActions&&<AgentAccountEntry identityId={identityId} runnerId={runnerId} profile={profile} disabled={disabled} onReturn={refresh}/>}
  </div>;
}
