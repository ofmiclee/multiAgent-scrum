import {useEffect,useRef,useState} from 'react';
import {Camera} from 'lucide-react';
import {z} from 'zod';
import {MemberDialog} from './InvitationLink';
import {accountRequest,AccountRequestError} from './account-api';
import './personal-profile.css';

const profileSchema=z.object({user:z.object({id:z.string(),name:z.string(),image:z.string().nullable(),signature:z.string(),version:z.number().int()}).strict()}).strict();
export type PersonalProfile=z.infer<typeof profileSchema>['user'];

export function ProfileAvatar({name,image}:{name:string;image?:string|null}){
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[image]);
  return <span className="profile-avatar">{image&&!failed?<img src={image} alt="个人头像" referrerPolicy="no-referrer" onError={()=>setFailed(true)}/>:Array.from(name)[0]||'我'}</span>;
}

export default function PersonalProfileDialog({identityId,onClose,onSaved}:{identityId:string;onClose:()=>void;onSaved:(user:PersonalProfile)=>void}){
  const [profile,setProfile]=useState<PersonalProfile|null>(null),[name,setName]=useState(''),[signature,setSignature]=useState('');
  const [avatar,setAvatar]=useState<string|null>(null),[busy,setBusy]=useState(false),[reading,setReading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const input=useRef<HTMLInputElement>(null),alive=useRef(true),selection=useRef(0);
  useEffect(()=>{
    alive.current=true;setError('');const controller=new AbortController();
    void accountRequest('/profile',profileSchema,{signal:controller.signal,expectedIdentity:identityId}).then(({user})=>{
      if(!controller.signal.aborted){setProfile(user);setName(user.name);setSignature(user.signature);}
    }).catch(()=>{if(!controller.signal.aborted)setError('个人资料加载失败，请重试。');});
    return()=>{alive.current=false;controller.abort();};
  },[identityId,retry]);
  async function select(file:File|undefined){
    if(!file)return;const current=++selection.current;setError('');
    if(file.size>10*1024*1024){setError('图片不能超过 10 MB。');return;}
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){setError('请选择 PNG、JPEG 或 WebP 图片。');return;}
    setReading(true);
    try{
      const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error());reader.readAsDataURL(file);});
      if(alive.current&&selection.current===current)setAvatar(data);
    }catch{if(alive.current)setError('图片读取失败，请重新选择。');}
    finally{if(alive.current&&selection.current===current)setReading(false);}
  }
  async function save(){
    if(!profile||busy||reading)return;setBusy(true);setError('');
    try{
      const {user}=await accountRequest('/profile',profileSchema,{expectedIdentity:identityId,body:{name:name.trim(),signature:signature.trim(),version:profile.version,...(avatar?{avatar:avatar.slice(avatar.indexOf(',')+1)}:{})}});
      if(alive.current){onSaved(user);onClose();}
    }catch(e){if(alive.current)setError(e instanceof AccountRequestError&&e.status===409?'资料已在其他页面更新，请关闭后重新打开。':e instanceof AccountRequestError&&e.status===400?'图片无法处理，请选择有效的 PNG、JPEG 或 WebP 图片。':'保存失败，请重试。');}
    finally{if(alive.current)setBusy(false);}
  }
  return <MemberDialog title="个人资料" onClose={()=>{if(!busy)onClose();}} className="personal-profile-dialog">
    <form onSubmit={event=>{event.preventDefault();void save();}} aria-busy={busy||reading}>
      <fieldset disabled={busy||!profile}>
        <div className="personal-profile-avatar"><button type="button" aria-label="更换头像" title="更换头像" disabled={reading} onClick={()=>input.current?.click()}><ProfileAvatar name={name} image={avatar??profile?.image}/><span className="profile-camera"><Camera size={16}/></span></button>
          <input ref={input} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择头像" disabled={reading} onChange={event=>{void select(event.target.files?.[0]);event.target.value='';}}/>
        </div>
        <div className="personal-profile-field"><label htmlFor="profile-name">昵称</label><input id="profile-name" autoComplete="nickname" required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></div>
        <div className="personal-profile-field"><label htmlFor="profile-signature">签名</label><textarea id="profile-signature" maxLength={200} rows={3} value={signature} onChange={event=>setSignature(event.target.value)}/></div>
      </fieldset>
      {error&&<p role="alert" className="field-error">{error}</p>}
      {!profile&&error&&<button className="text-button" type="button" onClick={()=>setRetry(value=>value+1)}>重新加载资料</button>}
      {!profile&&!error&&<p role="status">正在加载…</p>}
      <footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={!profile||busy||reading||!name.trim()}>{busy?'保存中…':reading?'读取图片中…':'保存'}</button></footer>
    </form>
  </MemberDialog>;
}
