import {useEffect,useRef,useState} from 'react';
import {Check,Mail} from './Icons';
import {z} from 'zod';
import {accountRequest,denied} from './account-api';

const invitationDate=z.string().datetime({offset:true});
const inboxInvitationSchema=z.object({id:z.uuid(),organizationId:z.uuid(),organizationName:z.string(),expiresAt:invitationDate}).strict();
import {organizationSchema} from './hierarchy';
const inboxSchema=z.object({invitations:z.array(inboxInvitationSchema)}).strict();
const acceptedSchema=z.object({organization:organizationSchema}).strict();
type Organization=z.infer<typeof organizationSchema>;
type Notice={error:boolean;text:string}|null;

function expiry(value:string){return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}

export function InvitationInbox({identityId,onAccepted}:{identityId:string;onAccepted:()=>Promise<void>}){
  const [invitations,setInvitations]=useState<z.infer<typeof inboxInvitationSchema>[]|null>(null);
  const [busyId,setBusyId]=useState<string|null>(null),[refreshing,setRefreshing]=useState(false),[notice,setNotice]=useState<Notice>(null);
  const [refreshOrganization,setRefreshOrganization]=useState<string|null>(null);
  const alive=useRef(true);
  useEffect(()=>{
    alive.current=true;const controller=new AbortController();setInvitations(null);setNotice(null);
    void accountRequest('/invitations',inboxSchema,{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setInvitations(result.invitations);})
      .catch(error=>{if(!controller.signal.aborted)setNotice({error:true,text:denied(error)?'邀请仅对完成邮箱验证的本人账号可见。':'邀请信息暂时无法加载，请重试。'});});
    return()=>{alive.current=false;controller.abort();};
  },[identityId]);
  async function accept(id:string){
    if(busyId||refreshing)return;setBusyId(id);setNotice(null);setRefreshOrganization(null);
    let organization:Organization;
    try{
      const result=await accountRequest('/invitations/'+id+'/accept',acceptedSchema,{body:{}});
      if(!alive.current)return;
      organization=result.organization;
    }catch(error){if(alive.current){
      setNotice({error:true,text:denied(error)?'邀请不可用、已过期或不属于当前账号。':'接受邀请未能完成，请稍后重试。'});setBusyId(null);
    }return;}
    setInvitations(current=>current?.filter(invitation=>invitation.id!==id)??null);
    setNotice({error:false,text:'已加入「'+organization.name+'」。组织成员资格不会自动授予项目或 Agent 权限。'});
    try{await onAccepted();}
    catch{if(alive.current){setRefreshOrganization(organization.name);setNotice({error:false,text:'邀请已接受，但组织列表暂时无法刷新。'});}}
    finally{if(alive.current)setBusyId(null);}
  }
  async function retryOrganizationRefresh(){
    if(refreshing||busyId)return;setRefreshing(true);
    try{
      await onAccepted();
      if(alive.current){setNotice({error:false,text:'已加入「'+refreshOrganization+'」，组织列表已重新加载。'});setRefreshOrganization(null);}
    }catch{if(alive.current)setNotice({error:false,text:'邀请已接受，但组织列表仍然无法刷新。请稍后重试。'});}
    finally{if(alive.current)setRefreshing(false);}
  }
  return <section className="management-block" aria-labelledby="invitation-inbox-title">
    <div className="section-heading"><div><div className="heading-with-tip"><h3 id="invitation-inbox-title">待处理邀请</h3></div></div><Mail size={18} aria-hidden="true"/></div>
    {notice&&<div className={'notice notice-'+(notice.error?'error':'success')} role={notice.error?'alert':'status'}>{!notice.error&&<Check size={16} aria-hidden="true"/>}{notice.text}</div>}
    {refreshOrganization&&<button className="secondary-button compact-button" type="button" disabled={refreshing||busyId!==null} onClick={()=>void retryOrganizationRefresh()}>{refreshing?'重新加载中…':'重新加载组织'}</button>}
    {invitations===null&&!notice?.error?<p className="loading-message" role="status">正在读取邀请…</p>
      :invitations?.length?<ul className="management-list">{invitations.map(invitation=><li key={invitation.id}>
        <div><strong>{invitation.organizationName}</strong><p>有效期至 {expiry(invitation.expiresAt)}</p></div>
        <button className="secondary-button" type="button" disabled={busyId!==null} onClick={()=>void accept(invitation.id)}>{busyId===invitation.id?'处理中…':'接受邀请'}</button>
      </li>)}</ul>:<p className="compact-empty">没有待处理邀请</p>}
  </section>;
}
