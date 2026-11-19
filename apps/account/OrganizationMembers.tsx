import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowLeft,UserPlus,Link,Trash2} from 'lucide-react';
import {z} from 'zod';
import {organizationSchema} from './hierarchy';
import {accountRequest,AccountRequestError} from './account-api';
import {JoinRequests} from './OrganizationInfo';
import {MemberName,joinedDate,memberSchema,membersSchema} from './MemberTable';
import InvitationLink,{MemberDialog} from './InvitationLink';
import {ConfirmDialog} from './Modal';

export default function OrganizationMembers({organization,name,onBack}:{organization:z.infer<typeof organizationSchema>;name:string;onBack:()=>void}){
  const [members,setMembers]=useState<z.infer<typeof memberSchema>[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const [dialog,setDialog]=useState<'add'|'invite'|null>(null),[email,setEmail]=useState(''),[addError,setAddError]=useState('');
  const [removing,setRemoving]=useState<z.infer<typeof memberSchema>|null>(null);
  const addRequest=useRef<{email:string;requestId:string}|null>(null);
  const owner=organization.role==='owner',path='/organizations/'+organization.id+'/members';
  const load=useCallback(async(signal?:AbortSignal)=>{const result=await accountRequest(path,membersSchema,{signal});if(!signal?.aborted)setMembers(result.members);},[path]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal).catch(()=>{if(!controller.signal.aborted)setNotice('成员列表暂时无法加载。');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[load]);
  const active=members.filter(m=>m.status==='active');
  async function removeMember(){
    if(!removing||busy)return;setBusy(true);setNotice('');
    try{await accountRequest(path,z.object({member:z.object({id:z.uuid(),role:z.string(),status:z.string(),version:z.number()}).strict()}).strict(),{body:{userId:removing.id,status:'suspended',expectedVersion:removing.version}});setRemoving(null);await load();}
    catch{setNotice('移除未能确认，请重新加载成员列表后核对。');try{await load();}catch{}}
    finally{setBusy(false);}
  }
  return <section className="members-page" aria-label="组织成员管理">
    <header className="workspace-page-heading"><div><h1>{organization.name} · 成员</h1><span>{loading?'正在读取成员…':active.length+' 位成员'}</span></div><div className="form-actions">{owner&&<button className="secondary-button" onClick={()=>{setEmail('');setAddError('');setDialog('add');}}><UserPlus size={16}/>添加成员</button>}<button className="primary-button" onClick={()=>setDialog('invite')}><Link size={16}/>邀请成员</button></div></header>
    {notice&&<p className="notice notice-error" role="alert">{notice}</p>}
    {loading?<p role="status">正在读取成员…</p>:<div className="member-table-scroll" role="region" aria-label="组织成员列表" tabIndex={0}><table className="member-table"><thead><tr><th scope="col">成员</th><th scope="col">角色</th><th scope="col">加入信息</th>{owner&&<th scope="col">操作</th>}</tr></thead><tbody>{active.map(m=><tr key={m.id}><td><MemberName name={m.name}/></td><td><span className="role-label">{m.role==='owner'?'组织创建者':'组织成员'}</span></td><td><span>{joinedDate(m.joinedAt)}</span>{m.invitedBy&&<small className="member-inviter">由 {m.invitedBy} 邀请</small>}</td>{owner&&<td>{m.role!=='owner'&&<button className="member-remove" title="移除成员" aria-label={'移除'+m.name} disabled={busy} onClick={()=>setRemoving(m)}><Trash2 size={16}/></button>}</td>}</tr>)}</tbody></table></div>}
    {owner&&<JoinRequests organizationId={organization.id} onChanged={()=>load()}/>}
    {dialog==='invite'&&<InvitationLink organization={organization} name={name} onClose={()=>setDialog(null)}/>}
    {dialog==='add'&&<MemberDialog title="添加组织成员" onClose={()=>{if(!busy)setDialog(null);}}><form className="story-form" onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setAddError('');try{const normalized=email.trim().toLowerCase();if(addRequest.current?.email!==normalized)addRequest.current={email:normalized,requestId:crypto.randomUUID()};await accountRequest(path+'/add',z.object({ok:z.literal(true)}).strict(),{body:addRequest.current});addRequest.current=null;setDialog(null);try{await load();}catch{setNotice('成员已添加，列表暂时无法刷新。');}}catch(error){setAddError(error instanceof AccountRequestError&&error.status===404?'未找到已验证邮箱的注册用户。':'添加未能确认，请重试。');}finally{setBusy(false);}}}><label>用户邮箱<input type="email" required autoFocus maxLength={254} value={email} disabled={busy} onChange={e=>setEmail(e.target.value)} placeholder="已注册并验证的邮箱"/></label>{addError&&<p role="alert">{addError}</p>}<div className="form-actions"><button className="secondary-button" type="button" disabled={busy} onClick={()=>setDialog(null)}>取消</button><button className="primary-button" disabled={busy}><UserPlus size={16}/>{busy?'添加中…':'添加成员'}</button></div></form></MemberDialog>}
    {removing&&<ConfirmDialog title="移出组织" description={<>将 <strong>{removing.name}</strong> 移出组织？对方将无法访问该组织及组织内项目。</>} confirmLabel="移出成员" danger busy={busy} onConfirm={()=>void removeMember()} onClose={()=>{if(!busy)setRemoving(null);}}/>}
  </section>;
}
