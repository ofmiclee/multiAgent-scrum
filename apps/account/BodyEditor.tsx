import {useEffect,useState,type ComponentType} from 'react';
import BodyContent from './BodyContent';
import editorModuleUrl from 'virtual:body-editor-url';

export type BodyEditorProps={projectId:string;value:string;onChange:(body:string)=>void;label:string;disabled?:boolean;maxLength:number;onUploading?:(busy:boolean)=>void};

export default function BodyEditor(props:BodyEditorProps){
  const [Editor,setEditor]=useState<ComponentType<BodyEditorProps>|null>(null);
  const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true;
    setFailed(false);
    const url=new URL(editorModuleUrl,window.location.href);
    if(attempt)url.searchParams.set('retry',crypto.randomUUID());
    void import(/* @vite-ignore */ url.href).then((module:typeof import('./BodyEditorContent'))=>{
      if(typeof module.default!=='function')throw Error('Body editor export unavailable');
      if(active)setEditor(()=>module.default);
    }).catch(()=>{if(active)setFailed(true);});
    return()=>{active=false;};
  },[attempt]);
  if(Editor)return <Editor {...props}/>;
  return <div className="body-editor body-editor-pending" aria-label={props.label} aria-busy={!failed}>
    {props.value&&<BodyContent body={props.value} projectId={props.projectId}/>}
    {failed?<><p role="alert">正文编辑器未能加载，请检查网络后重试。已填写的内容会保留。</p><button type="button" className="secondary-button" onClick={()=>setAttempt(n=>n+1)}>重试加载</button></>:<p role="status">正在加载正文编辑器…</p>}
  </div>;
}
