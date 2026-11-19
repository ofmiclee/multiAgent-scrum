import {useCallback,useEffect,useState} from 'react';
import {UserPlus,Trash2} from 'lucide-react';
import {z} from 'zod';
import {accountRequest} from './account-api';
import {projectSchema,roleLabel} from './hierarchy';
import {MemberName,joinedDate,memberSchema,membersSchema} from './MemberTable';
import {ConfirmDialog} from './Modal';

type Role='manager'|'member'|'viewer';
export default function ProjectMembers({organizationId,project}:{organizationId:string;project:z.infer<typeof projectSchema>}){
  const [members,setMembers]=useState<z.infer<typeof memberSchema>[]>([]),[organizationMembers,setOrganizationMembers]=useState<z.infer<typeof memberSchema>[]>([]);
  const [userId,setUserId]=useState(''),[role,setRole]=useState<Role>('member'),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[loading,setLoading]=useState(true);
  const [removing,setRemoving]=useState<z.infer<typeof memberSchema>|null>(null);
  const manage=['owner','manager'].includes(project.role),roles:Role[]=project.role==='owner'?['manager','member','viewer']:['member','viewer'];
  const path='/projects/'+project.id+'/members';
  const load=useCallback(async(signal?:AbortSignal)=>{
    const result=await accountRequest(path,membersSchema,{signal});
    const organization=manage?await accountRequest('/organizations/'+organizationId+'/members',membersSchema,{signal}):{members:[]};
    if(signal?.aborted)return;setMembers(result.members);setOrganizationMembers(organization.members);
  },[path,organizationId,manage]);
  useEffect(()=>{const controller=new AbortController();void load(controller.signal).catch(()=>{if(!controller.signal.aborted)setNotice('成员列表暂时无法加载。');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[load]);
  async function change(id:string,status:'active'|'suspended',nextRole?:Role){
    if(busy)return;setBusy(true);setNotice('');
    try{
      await accountRequest(path,z.object({member:memberSchema}).strict(),{body:{userId:id,status,expectedVersion:members.find(m=>m.id===id)?.version??0,...(nextRole?{role:nextRole}:{})}});
      setUserId('');await load();return true;
    }catch{setNotice('修改未能确认或成员权限已变化，请核对列表后重试。');try{await load();}catch{setNotice('成员列表暂时无法重新加载，请重新进入本页。');}return false;}
    finally{setBusy(false);}
  }
  async function removeMember(){
    if(!removing||busy)return;
    if(await change(removing.id,'suspended'))setRemoving(null);
  }
  const candidates=organizationMembers.filter(m=>m.status==='active'&&!members.some(p=>p.id===m.id&&p.status==='active'));
  return <section className="members-page" aria-label="项目成员管理">
    <header className="workspace-page-heading"><div><h1>项目成员</h1><span>{loading?'正在读取成员…':members.filter(m=>m.status==='active').length+' 位成员'}</span></div></header>
    {notice&&<p className="notice notice-error" role="alert">{notice}</p>}
    {manage&&<form className="member-add-form" aria-label="添加项目成员" onSubmit={e=>{e.preventDefault();void change(userId,'active',role);}}>
      <label>选择组织用户<select required value={userId} disabled={busy||loading} onChange={e=>setUserId(e.target.value)}><option value="">{candidates.length?'选择组织用户':'暂无可添加用户'}</option>{candidates.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label>项目角色<select value={role} disabled={busy} onChange={e=>setRole(e.target.value as Role)}>{roles.map(r=><option key={r} value={r}>{roleLabel[r]}</option>)}</select></label>
      <button className="primary-button" disabled={busy||!userId}><UserPlus size={16}/>添加成员</button>
    </form>}
    {loading?<p role="status">正在读取成员…</p>:<div className="member-table-scroll" role="region" aria-label="项目成员列表" tabIndex={0}><table className="member-table"><thead><tr><th scope="col">成员</th><th scope="col">角色</th><th scope="col">加入时间</th>{manage&&<th scope="col">操作</th>}</tr></thead><tbody>{members.filter(m=>m.status==='active').map(m=>{
      const editable=manage&&m.role!=='owner'&&(project.role==='owner'||m.role!=='manager');
      return <tr key={m.id}><td><MemberName name={m.name}/></td><td>{editable?<select aria-label={m.name+'的角色'} value={m.role} disabled={busy} onChange={e=>void change(m.id,'active',e.target.value as Role)}>{roles.map(r=><option key={r} value={r}>{roleLabel[r]}</option>)}</select>:<span className="role-label">{roleLabel[m.role as keyof typeof roleLabel]}</span>}</td><td>{joinedDate(m.joinedAt)}</td>{manage&&<td>{editable&&<button className="member-remove" aria-label={'移除'+m.name} title="移除成员" disabled={busy} onClick={()=>setRemoving(m)}><Trash2 size={16}/></button>}</td>}</tr>;
    })}</tbody></table></div>}
    {removing&&<ConfirmDialog title="移出项目" description={<>将 <strong>{removing.name}</strong> 移出项目？</>} confirmLabel="移出成员" danger busy={busy} onConfirm={()=>void removeMember()} onClose={()=>{if(!busy)setRemoving(null);}}/>}
  </section>;
}
