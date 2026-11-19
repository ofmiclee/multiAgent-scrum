import {useEffect,useState,useRef} from 'react';
import {z} from 'zod';
import {projectSchema} from './hierarchy';
import {usePageState} from './page-state';
import {accountRequest} from './account-api';
import './project-settings.css';
import ProjectFiles from './ProjectFiles';

const response=z.object({project:projectSchema.pick({id:true,name:true,key:true,description:true,version:true})}).strict();
const settingsTabSchema=z.enum(['base','config','personal']);
const settingsTabs=['base','config','personal'] as const;
export default function ProjectSettings({project,onChanged}:{project:z.infer<typeof projectSchema>;onChanged:(value:z.infer<typeof projectSchema>)=>void}){
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const [current,setCurrent]=useState<z.infer<typeof response>['project']>(project),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [tab,setTab]=usePageState('project.'+project.id+'.settings-tab',settingsTabSchema,'base');
  const opened=useRef({projectId:project.id,tabs:new Set<typeof tab>([tab])});
  if(opened.current.projectId!==project.id)opened.current={projectId:project.id,tabs:new Set([tab])};
  opened.current.tabs.add(tab);
  const [loadFailed,setLoadFailed]=useState(false),[loadRevision,setLoadRevision]=useState(0);
  const [draft,setDraft]=usePageState('project.'+project.id+'.metadata',z.object({name:z.string().max(120),description:z.string().max(200),key:z.string().max(10),version:z.number()}).nullable(),null);
  useEffect(()=>{const controller=new AbortController();setLoadFailed(false);void accountRequest('/projects/'+project.id+'/settings',response,{signal:controller.signal}).then(r=>{if(!controller.signal.aborted)setCurrent(r.project);}).catch(()=>{if(!controller.signal.aborted)setLoadFailed(true);});return()=>controller.abort();},[project.id,loadRevision]);
  const value=draft??{name:current.name,description:current.description??'',key:current.key??'',version:current.version};
  const readOnly=project.role!=='owner';
  return <section className="project-settings-page" aria-labelledby="project-settings-title">
    <header className="workspace-page-heading"><div><h1 id="project-settings-title">项目设置</h1><span>{tab==='base'?'项目基础信息':tab==='config'?'代码仓库与项目规范':'Runner 与本机配置'}</span></div></header>
    <div className="project-settings-tabs" role="tablist" aria-label="项目设置分类">
      {settingsTabs.map(value=><button key={value} type="button" role="tab" id={'project-settings-tab-'+value} aria-selected={tab===value} aria-controls={'project-settings-panel-'+value} tabIndex={tab===value?0:-1} onKeyDown={event=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
        event.preventDefault();const next=event.key==='Home'?'base':event.key==='End'?'personal':settingsTabs[(settingsTabs.indexOf(value)+(event.key==='ArrowLeft'?-1:1)+settingsTabs.length)%settingsTabs.length]!;setTab(next);document.getElementById('project-settings-tab-'+next)?.focus();
      }} onClick={()=>setTab(value)}>{value==='base'?'基础信息':value==='config'?'项目配置':'我的配置'}</button>)}
    </div>
    <div id="project-settings-panel-base" role="tabpanel" aria-labelledby="project-settings-tab-base" hidden={tab!=='base'}>
    <form className="project-settings-form" aria-label="项目信息" onSubmit={async e=>{
      e.preventDefault();if(busy||readOnly)return;setBusy(true);setNotice('');
      try{
        const r=await accountRequest('/projects/'+project.id+'/settings',response,{body:{name:value.name,description:value.description,expectedVersion:value.version}});
        if(!alive.current)return;setCurrent(r.project);setDraft(null);onChanged({...project,...r.project});setNotice('项目信息已保存。');
      }catch{
        if(!alive.current)return;setNotice('保存未能确认或版本已变化，草稿已保留。');
        try{const r=await accountRequest('/projects/'+project.id+'/settings',response);if(alive.current)setCurrent(r.project);}catch{}
      }finally{if(alive.current)setBusy(false);}
    }}>
      {loadFailed&&<div className="project-settings-conflict" role="alert"><p>项目信息无法读取，当前修改已保留。</p><button type="button" onClick={()=>setLoadRevision(value=>value+1)}>重新加载项目信息</button></div>}
      <label htmlFor="settings-project-key">项目 Key（不可修改）</label>
      <input id="settings-project-key" value={current.key??''} disabled/>
      <label htmlFor="settings-project-name">名称</label>
      <input id="settings-project-name" required maxLength={120} disabled={busy||readOnly} value={value.name} onChange={e=>setDraft({...value,name:e.target.value})}/>
      <label htmlFor="settings-project-description">描述</label>
      <textarea id="settings-project-description" rows={3} maxLength={200} disabled={busy||readOnly} value={value.description} onChange={e=>setDraft({...value,description:e.target.value})}/>
      {notice&&<p role="status">{notice}</p>}
      {draft&&draft.version!==current.version&&<div className="project-settings-conflict" role="alert"><p>项目信息已被更新，请选择如何处理草稿。</p><div><button type="button" disabled={busy} onClick={()=>setDraft({...draft,version:current.version,key:current.key??''})}>保留我的修改</button><button type="button" disabled={busy} onClick={()=>setDraft(null)}>使用当前版本</button></div></div>}
      {!readOnly&&<button className="project-settings-save" disabled={busy||value.version!==current.version}>{busy?'保存中…':'保存'}</button>}
    </form>
    </div>
    {opened.current.tabs.has('config')&&<div id="project-settings-panel-config" role="tabpanel" aria-labelledby="project-settings-tab-config" hidden={tab!=='config'}><ProjectFiles key={project.id+':config'} projectId={project.id} tab="config" active={tab==='config'}/></div>}
    {opened.current.tabs.has('personal')&&<div id="project-settings-panel-personal" role="tabpanel" aria-labelledby="project-settings-tab-personal" hidden={tab!=='personal'}><ProjectFiles key={project.id+':personal'} projectId={project.id} tab="personal" active={tab==='personal'}/></div>}
  </section>;
}
