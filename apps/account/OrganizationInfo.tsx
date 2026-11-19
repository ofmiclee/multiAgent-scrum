import RequiredMark from './RequiredMark';
import {useEffect,useState,useRef} from 'react';
import {Camera} from 'lucide-react';
import {z} from 'zod';
import {organizationSchema} from './hierarchy';
import {accountRequest,AccountRequestError} from './account-api';
import {usePageState,usePageRef} from './page-state';
import OrganizationAvatar from './OrganizationAvatar';
const response=z.object({organization:organizationSchema}).strict();
const join=z.object({id:z.uuid(),organizationId:z.uuid(),userId:z.uuid(),status:z.string(),createdAt:z.string(),decidedAt:z.string().nullable()}).strict();
export function JoinOrganization(){
 const [slug,setSlug]=usePageState('organization.join.slug',z.string().max(50),''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const pending=usePageRef('organization.join.pending',z.object({slug:z.string(),requestId:z.uuid()}).nullable(),null);
 return <form className="organization-form" aria-label="申请加入组织" onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);try{if(pending.current?.slug!==slug.trim())pending.current={slug:slug.trim(),requestId:crypto.randomUUID()};await accountRequest('/organization-join-requests',z.object({request:join}).strict(),{body:pending.current});pending.current=null;setNotice('申请已提交，等待组织所有者审批。');}catch{setNotice('申请未能确认，请核对组织名称后重试。');}finally{setBusy(false);}}}>
  <h3>申请加入组织</h3><label htmlFor="join-slug">组织标识<RequiredMark/></label><input id="join-slug" required maxLength={50} value={slug} onChange={e=>setSlug(e.target.value)} disabled={busy}/><button className="secondary-button" disabled={busy}>提交申请</button>{notice&&<p role="status">{notice}</p>}
 </form>;
}
export function JoinRequests({organizationId,onChanged}:{organizationId:string;onChanged?:()=>Promise<void>}){
 const row=join.extend({name:z.string(),invitedBy:z.string().nullable().optional()}),[rows,setRows]=useState<z.infer<typeof row>[]>([]),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const path='/organizations/'+organizationId+'/join-requests';
 async function load(){const r=await accountRequest(path,z.object({requests:z.array(row)}).strict());setRows(r.requests);}
 useEffect(()=>{void load().catch(()=>setNotice('加入申请暂时无法读取。'));},[organizationId]);
 if(!rows.some(r=>r.status==='pending')&&!notice)return null;
 return <section className="member-approvals" aria-label="待审核加入申请"><h3>待审核加入申请</h3>{notice&&<p role="alert">{notice}</p>}<ul className="management-list">{rows.filter(r=>r.status==='pending').map(r=><li key={r.id}><div><strong>{r.name}</strong>{r.invitedBy&&<p>由 {r.invitedBy} 邀请</p>}</div><div className="form-actions">{(['approve','reject'] as const).map(decision=><button key={decision} disabled={busy} className="secondary-button" onClick={async()=>{setBusy(true);setNotice('');try{await accountRequest(path+'/'+r.id,z.object({request:join}).strict(),{body:{decision}});await load();await onChanged?.();}catch{setNotice('审批未能确认，邀请可能已失效，请重新加载后核对。');}finally{setBusy(false);}}}>{decision==='approve'?'同意加入':'拒绝'}</button>)}</div></li>)}</ul></section>;
}
export default function OrganizationInfo({organization,onChanged}:{organization:z.infer<typeof organizationSchema>;onChanged:(value:z.infer<typeof organizationSchema>)=>void}){
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const [current,setCurrent]=useState(organization),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [avatar,setAvatar]=useState<string|null>(null),[reading,setReading]=useState(false);
 const input=useRef<HTMLInputElement>(null),selection=useRef(0);
 const [draft,setDraft]=usePageState('organization.'+organization.id+'.metadata',z.object({alias:z.string().max(50),description:z.string().max(200),slug:z.string().max(50),version:z.number()}).nullable(),null);
 useEffect(()=>{let active=true;void accountRequest('/organizations/'+organization.id,response).then(r=>{if(active)setCurrent(r.organization);}).catch(()=>{if(active)setNotice('组织信息暂时无法读取。');});return()=>{active=false;};},[organization.id]);
 const value=draft??{alias:current.alias??'',description:current.description??'',slug:current.slug??'',version:current.version};
 const readOnly=current.role!=='owner';
 async function selectAvatar(file:File|undefined){
  if(!file)return;const selected=++selection.current;setNotice('');
  if(file.size>10*1024*1024){setNotice('图片不能超过 10 MB。');return;}
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){setNotice('请选择 PNG、JPEG 或 WebP 图片。');return;}
  setReading(true);
  try{const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error());reader.readAsDataURL(file);});if(alive.current&&selection.current===selected)setAvatar(data);}
  catch{if(alive.current)setNotice('图片读取失败，请重新选择。');}
  finally{if(alive.current&&selection.current===selected)setReading(false);}
 }
 return <section><header className="workspace-page-heading"><h1>组织信息</h1></header><form className="story-form organization-info-form" onSubmit={async e=>{e.preventDefault();if(readOnly||busy||reading||!value.alias.trim())return;setBusy(true);try{const r=await accountRequest('/organizations/'+current.id,response,{body:{alias:value.alias,description:value.description,expectedVersion:value.version,...(!current.slug?{slug:value.slug}:{}),...(avatar?{avatar:avatar.slice(avatar.indexOf(',')+1)}:{})}});if(!alive.current)return;setCurrent(r.organization);setDraft(null);setAvatar(null);onChanged(r.organization);setNotice('组织信息已保存。');}catch(error){if(!alive.current)return;setNotice(error instanceof AccountRequestError&&error.status===413?'图片不能超过 10 MB。':error instanceof AccountRequestError&&error.status===400?'请填写组织名称，并选择有效的头像图片。':'保存未能确认或版本已变化，草稿已保留。');try{const r=await accountRequest('/organizations/'+organization.id,response);if(alive.current)setCurrent(r.organization);}catch{}}finally{setBusy(false);}}}>
 {!readOnly&&<div className="organization-avatar-editor"><button type="button" aria-label="更换组织头像" title="更换组织头像" disabled={busy||reading} onClick={()=>input.current?.click()}><OrganizationAvatar name={value.alias||current.name} image={avatar??current.image}/><span className="profile-camera"><Camera size={16}/></span></button><input ref={input} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择组织头像" disabled={busy||reading} onChange={event=>{void selectAvatar(event.target.files?.[0]);event.target.value='';}}/></div>}
 {notice&&<p role="status">{notice}</p>}{draft&&draft.version!==current.version&&<div role="alert"><p>当前版本 {current.version}：{current.alias} · {current.description}</p><button type="button" disabled={busy} onClick={()=>setDraft({...draft,version:current.version,slug:current.slug??draft.slug})}>保留我的修改</button><button type="button" disabled={busy} onClick={()=>setDraft(null)}>使用当前版本</button></div>}{(['slug','alias','description'] as const).map(field=><label key={field}>{field==='slug'?'组织标识':field==='alias'?'组织名称':'组织简介'}<RequiredMark required={field!=='description'}/>{field==='description'?<textarea maxLength={200} value={value[field]} disabled={busy||readOnly} onChange={e=>setDraft({...value,[field]:e.target.value})}/>:<input required maxLength={50} value={value[field]} disabled={busy||readOnly||field==='slug'&&!!current.slug} onChange={e=>setDraft({...value,[field]:e.target.value})}/>}</label>)}{!readOnly&&<button className="primary-button" disabled={busy||reading||!value.alias.trim()||value.version!==current.version}>{busy?'保存中…':reading?'读取图片中…':'保存组织信息'}</button>}
 </form></section>;
}
