import {useEffect,useState} from 'react';

export default function OrganizationAvatar({name,image}:{name:string;image?:string|null}){
  const [failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[image]);
  return <span className="organization-avatar" role="img" aria-label={name+'的组织头像'}>
    {image&&!failed?<img src={image} alt="组织头像" onError={()=>setFailed(true)}/>:Array.from(name.trim())[0]?.toLocaleUpperCase()||'组'}
  </span>;
}
