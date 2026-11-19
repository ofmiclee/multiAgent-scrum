import {useRef,useState,type FormEvent} from 'react';
import {z} from 'zod';
import {MemberDialog} from './InvitationLink';
import BodyEditor from './BodyEditor';
import {accountRequest,AccountRequestError,denied} from './account-api';
import RequiredMark from './RequiredMark';

export default function CreateWorkDialog({kind,projectId,boardId,onClose,onCreated}:{kind:'story'|'task';projectId:string;boardId:string;onClose:()=>void;onCreated:()=>void}){
  const [title,setTitle]=useState(''),[body,setBody]=useState(''),[busy,setBusy]=useState(false),[uploading,setUploading]=useState(false),[notice,setNotice]=useState('');
  const pending=useRef<{fingerprint:string;requestId:string}|null>(null),working=useRef(false);
  const isStory=kind==='story',name=isStory?'故事':'任务',maxLength=isStory?12000:4000;
  async function save(event:FormEvent){
    event.preventDefault();if(working.current||uploading||!body.trim()||body.length>maxLength||(isStory&&!title.trim()))return;
    const content={...(isStory?{title:title.trim()}:{}),body};
    const fingerprint=JSON.stringify(content);
    if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,requestId:crypto.randomUUID()};
    working.current=true;setBusy(true);setNotice('');
    try{
      const path='/projects/'+projectId+'/boards/'+boardId;
      const input={...content,requestId:pending.current.requestId};
      if(isStory)await accountRequest(path+'/stories',z.object({story:z.object({id:z.uuid(),projectId:z.literal(projectId),boardId:z.literal(boardId)})}),{body:input});
      else await accountRequest(path+'/tasks',z.object({taskId:z.uuid()}).strict(),{body:input});
      onCreated();
    }catch(error){setNotice(denied(error)?'当前账号无权创建，请重新检查项目权限。':error instanceof AccountRequestError&&error.status===400?'内容或图片已失效，请检查后重试。':'创建结果尚未确认，请重试。已填写的内容会保留。');}
    finally{working.current=false;setBusy(false);}
  }
  return <MemberDialog title={'新建'+name} onClose={()=>{if(!working.current&&!uploading)onClose();}} className="work-composer-dialog">
    <form className="work-composer-form" onSubmit={save} onKeyDownCapture={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!working.current&&!uploading)onClose();}}}>
      {isStory&&<label>故事标题<RequiredMark/><input autoFocus required maxLength={200} value={title} disabled={busy} onChange={e=>setTitle(e.target.value)}/></label>}
      <div><div className="field-label">{name}正文<RequiredMark/></div><BodyEditor projectId={projectId} value={body} onChange={setBody} label={name+'正文'} disabled={busy} maxLength={maxLength} onUploading={setUploading}/></div>
      {notice&&<p role="alert" className="notice notice-error">{notice}</p>}
      <div className="form-actions"><button type="button" className="secondary-button" disabled={busy||uploading} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy||uploading||!body.trim()||body.length>maxLength||(isStory&&!title.trim())}>{busy?'创建中…':'创建'+name}</button></div>
    </form>
  </MemberDialog>;
}
