import {useEffect,useId,useState} from 'react';
import {z} from 'zod';
import {accountRequest} from './account-api';
import {modelDirectorySchema} from '../../packages/domain/agent-models';

const listing=z.object({identityId:z.string(),models:modelDirectorySchema}).strict();
export default function AgentModel({identityId,profile,value,onChange,disabled}:{identityId:string;profile:string;value:string|null;onChange:(model:string|null,entry?:z.infer<typeof modelDirectorySchema>[number])=>void;disabled:boolean}){
  const id=useId(),[models,setModels]=useState<z.infer<typeof modelDirectorySchema>>([]),[failed,setFailed]=useState(false),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  useEffect(()=>{
    setModels([]);setFailed(false);setLoading(profile!=='demo');
    if(profile==='demo')return;
    let active=true;const stop=new AbortController();
    const load=async()=>{
      try{
        const result=await accountRequest('/agent-models',listing,{signal:stop.signal});
        if(result.identityId!==identityId)throw Error('Identity changed');
        if(active){setModels(result.models.filter(model=>model.profile===profile));setFailed(false);}
      }catch{if(active){setModels([]);setFailed(true);}}
      finally{if(active)setLoading(false);}
    };
    void load();return()=>{active=false;stop.abort();};
  },[identityId,profile,revision]);
  if(profile==='demo')return null;
  const choices=[...models].sort((a,b)=>{
    const version=(value:string)=>Number(value.match(/^\d+(?:\.\d+)?/)?.[0]??Number.NEGATIVE_INFINITY);
    return version(b.displayName)-version(a.displayName);
  }),defaultEntry=choices.find(choice=>choice.isDefault),defaultModel=defaultEntry?.model??null,defaultLabel=defaultEntry?.displayName??null;
  const vendors=[...new Set(choices.map(choice=>choice.vendor))];
  const vendorName=(vendor:string)=>vendor==='deepseek'?'DeepSeek':vendor==='openai'?'OpenAI':vendor;
  return <div className="story-form" aria-busy={loading}>
    <label htmlFor={id}>模型</label>
    <select id={id} value={value??''} disabled={disabled||loading||failed} aria-describedby={!choices.length?id+'-status':undefined} onChange={e=>{const model=e.target.value||null;onChange(model,choices.find(entry=>entry.model===(model??defaultModel)));}}>
      <option value="">默认模型{defaultLabel?'：'+defaultLabel:''}</option>
      {value&&!choices.some(model=>model.model===value)&&<option value={value} disabled>{value} · 未在系统目录中</option>}
      {vendors.map(vendor=><optgroup key={vendor} label={vendorName(vendor)}>{choices.filter(model=>model.vendor===vendor).map(model=><option key={model.model} value={model.model}>{model.displayName}{model.isDefault?' · 默认':''}</option>)}</optgroup>)}
    </select>
    {!choices.length&&<span id={id+'-status'} className="field-hint" role={failed?'alert':'status'}>{loading?'正在读取模型目录…':failed?<>模型目录读取失败。<button type="button" className="text-button" disabled={disabled} onClick={()=>setRevision(value=>value+1)}>重新加载模型</button></>:'系统暂未配置此执行类型的模型。'}</span>}
  </div>;
}
