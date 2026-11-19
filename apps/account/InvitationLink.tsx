import {useEffect,useRef,useState} from 'react';
import {Copy,UsersRound,Check} from 'lucide-react';
import {QRCodeSVG} from 'qrcode.react';
import {z} from 'zod';
import {accountRequest} from './account-api';
import {Modal} from './Modal';

const linkSchema=z.object({link:z.object({id:z.uuid(),expiresAt:z.string(),maxUses:z.number(),approvalRequired:z.boolean()}).strict()}).strict();
const previewSchema=z.object({invitation:z.object({organizationName:z.string(),inviterName:z.string(),expiresAt:z.string(),approvalRequired:z.boolean(),remaining:z.number(),status:z.string()}).strict()}).strict();
export function invitationToken(){return /^#join-invite=([a-f0-9]{64})$/.exec(window.location.hash)?.[1]??null;}
const returnKey='mas.invitation.oauth-return';
export function rememberInvitationReturn(){
  const token=invitationToken();if(!token)return;
  sessionStorage.setItem(returnKey,JSON.stringify({token,until:Date.now()+10*60_000}));
}
export function clearInvitationReturn(){try{sessionStorage.removeItem(returnKey);}catch{}}
export function restoreInvitationReturn(){
  try{
    const raw=sessionStorage.getItem(returnKey);clearInvitationReturn();
    if(raw&&!location.hash){const value=JSON.parse(raw);if(typeof value.token==='string'&&/^[a-f0-9]{64}$/.test(value.token)&&typeof value.until==='number'&&value.until>Date.now())history.replaceState(null,'',location.pathname+location.search+'#join-invite='+value.token);}
  }catch{}
  return invitationToken();
}
function expiry(value:string){return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}

export function MemberDialog({title,onClose,children,className=''}:{title:string;onClose:()=>void;children:React.ReactNode;className?:string}){
  return <Modal title={title} onClose={onClose} className={className}>{children}</Modal>;
}

export default function InvitationLink({organization,name,onClose}:{organization:{id:string;name:string;role:string};name:string;onClose:()=>void}){
  const [maxUses,setMaxUses]=useState(1),[hours,setHours]=useState(24),[busy,setBusy]=useState(true),[notice,setNotice]=useState(''),[copied,setCopied]=useState(false),[retry,setRetry]=useState(0);
  const [created,setCreated]=useState<{url:string;expiresAt:string;maxUses:number;hours:number;organizationId:string}|null>(null);
  const pending=useRef<{organizationId:string;input:{token:string;requestId:string;maxUses:number;hours:number}}|null>(null);
  useEffect(()=>{
    let active=true;
    setBusy(true);setNotice('');setCopied(false);setCreated(null);
    const timer=setTimeout(async()=>{
      if(!pending.current||pending.current.organizationId!==organization.id||pending.current.input.maxUses!==maxUses||pending.current.input.hours!==hours){
        const bytes=crypto.getRandomValues(new Uint8Array(32));
        pending.current={organizationId:organization.id,input:{token:Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''),requestId:crypto.randomUUID(),maxUses,hours}};
      }
      const {input}=pending.current;
      try{
        const {link}=await accountRequest('/organizations/'+organization.id+'/invite-links',linkSchema,{body:input,signal:AbortSignal.timeout(15_000)});
        if(active)setCreated({url:location.origin+location.pathname+'#join-invite='+input.token,expiresAt:link.expiresAt,maxUses,hours,organizationId:organization.id});
      }catch{if(active)setNotice('邀请未能生成，请重试。');}
      finally{if(active)setBusy(false);}
    },300);
    return()=>{active=false;clearTimeout(timer);};
  },[organization.id,maxUses,hours,retry]);
  const current=created?.organizationId===organization.id&&created.maxUses===maxUses&&created.hours===hours?created:null;
  return <MemberDialog title="邀请成员加入组织" onClose={onClose} className="invitation-dialog"><div className="invitation-layout">
    <section className="invitation-preview"><UsersRound size={28}/><h3>{name} 邀请你加入组织</h3><strong>{organization.name}</strong><div className="invitation-qr">{current?<QRCodeSVG value={current.url} size={196} marginSize={4} title="组织邀请二维码"/>:<p role="status">{busy?'正在生成二维码…':'二维码未能生成'}</p>}</div><p>邀请成员上限 {maxUses} 位</p><p>{current?'有效期至 '+expiry(current.expiresAt):'有效期 '+hours+' 小时'}</p></section>
    <section className="invitation-controls"><div className="invitation-org"><UsersRound size={22}/><strong>{organization.name}</strong></div>
      <label htmlFor="invite-count">邀请人数 <input id="invite-count" type="number" min={1} max={500} value={maxUses} onChange={e=>{setMaxUses(Math.min(500,Math.max(1,Number(e.target.value))));setCopied(false);}}/></label><input aria-label="邀请人数滑块" type="range" min={1} max={500} value={maxUses} onChange={e=>setMaxUses(Number(e.target.value))}/><div className="range-labels"><span>1</span><span>500</span></div>
      <label htmlFor="invite-hours">邀请有效期（小时）<input id="invite-hours" type="number" min={1} max={48} value={hours} onChange={e=>{setHours(Math.min(48,Math.max(1,Number(e.target.value))));setCopied(false);}}/></label><input aria-label="邀请有效期滑块" type="range" min={1} max={48} value={hours} onChange={e=>setHours(Number(e.target.value))}/><div className="range-labels"><span>1</span><span>48</span></div>
      <p className="invitation-policy">{organization.role==='owner'?'成员接受邀请后即可加入组织。':'成员接受邀请后，需组织创建者审核。'}</p>
      {current?<><label className="invite-url-label">邀请链接<input readOnly value={current.url} onFocus={e=>e.target.select()}/></label><button className="primary-button" onClick={async()=>{try{await navigator.clipboard.writeText(current.url);setCopied(true);setNotice('');}catch{setNotice('复制失败，请选择上方链接复制。');}}}>{copied?<Check size={16}/>:<Copy size={16}/>} {copied?'已复制':'复制邀请链接'}</button></>:<button className="primary-button" disabled={busy} onClick={()=>setRetry(value=>value+1)}>{busy?'生成中…':'重新生成'}</button>}
      {notice&&<p role="alert">{notice}</p>}
    </section>
  </div></MemberDialog>;
}

export function JoinInvitation({token,onJoined,onBack}:{token:string;onJoined:()=>Promise<void>;onBack:()=>void}){
  const [preview,setPreview]=useState<z.infer<typeof previewSchema>['invitation']|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{const controller=new AbortController();setPreview(null);setNotice('');void accountRequest('/invitation-links/inspect',previewSchema,{body:{token},signal:controller.signal}).then(r=>setPreview(r.invitation)).catch(()=>{if(!controller.signal.aborted)setNotice('邀请不可用、已过期，或当前账号尚未验证邮箱。');});return()=>controller.abort();},[token]);
  const done=preview&&['joined','approved','pending','rejected'].includes(preview.status);
  return <section className="join-invitation"><header className="workspace-page-heading"><div><UsersRound size={24}/><h1>组织邀请</h1></div></header>{preview&&<><h2>{preview.organizationName}</h2><p>{preview.inviterName} 邀请你加入</p><p>有效期至 {expiry(preview.expiresAt)}</p><p>{preview.status==='pending'?'已提交，等待组织创建者审核。':preview.status==='rejected'?'加入申请已被拒绝。':preview.status==='joined'||preview.status==='approved'?'你已加入该组织。':preview.approvalRequired?'接受邀请后，需组织创建者审核。':'接受邀请后即可加入组织。'}</p>{!done&&<button className="primary-button" disabled={busy||preview.remaining===0} onClick={async()=>{setBusy(true);setNotice('');try{const result=await accountRequest('/invitation-links/accept',z.object({status:z.string()}).strict(),{body:{token}});setPreview({...preview,status:result.status});if(result.status==='joined'||result.status==='approved')await onJoined();}catch{setNotice('邀请未能接受，请重新加载核对有效期与剩余人数。');}finally{setBusy(false);}}}>{preview.remaining===0?'邀请名额已用完':busy?'处理中…':'接受邀请'}</button>}</>}{notice&&<p role="alert">{notice}</p>}</section>;
}
