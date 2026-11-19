import {createContext,useCallback,useContext,useEffect,useMemo,useRef,useState,type SetStateAction} from 'react';
import {z} from 'zod';

// Tab-local navigation and explicitly allowlisted non-secret drafts (24 hours).
// Restored IDs are fetched through the authenticated API, never permission proof.
export const PageIdentity=createContext<string|null>(null);
const prefix='mas.page.v1.';
const record=z.object({expiresAt:z.number(),value:z.unknown()});
const volatile=new Map<string,z.infer<typeof record>>(),failedKeys=new Set<string>();
function notifyStorage(){window.dispatchEvent(new Event('mas-page-storage'));}
export function readPageState<T>(identity:string,key:string,schema:z.ZodType<T>,fallback:T):T{
  try{
    const storageKey=prefix+identity+'.'+key;
    const stored=record.safeParse(volatile.get(storageKey)??JSON.parse(sessionStorage.getItem(storageKey)??'null'));
    if(!stored.success||stored.data.expiresAt<Date.now())return fallback;
    const parsed=schema.safeParse(stored.data.value);return parsed.success?parsed.data:fallback;
  }catch{return fallback; /* Storage-disabled browsers still support navigation. */}
}
export function writePageState(identity:string,key:string,value:unknown){
  const storageKey=prefix+identity+'.'+key,entry={expiresAt:Date.now()+24*60*60_000,value};
  try{sessionStorage.setItem(storageKey,JSON.stringify(entry));volatile.delete(storageKey);if(failedKeys.delete(storageKey))notifyStorage();}
  catch{volatile.set(storageKey,entry);failedKeys.add(storageKey);notifyStorage();}
}
export function clearPageState(identity:string){
  for(const key of volatile.keys())if(key.startsWith(prefix+identity+'.')){volatile.delete(key);failedKeys.delete(key);}
  try{for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix+identity+'.'))sessionStorage.removeItem(key);}
  catch{/* Storage is optional; server sign-out remains authoritative. */}
}
export function DraftStorageNotice(){
  const identity=useContext(PageIdentity),[revision,refresh]=useState(0);
  useEffect(()=>{const changed=()=>refresh(value=>value+1);window.addEventListener('mas-page-storage',changed);return()=>window.removeEventListener('mas-page-storage',changed);},[]);
  const failed=!!identity&&[...failedKeys].some(key=>key.startsWith(prefix+identity+'.'));
  return failed?<p className="notice notice-error" role="alert" data-storage-revision={revision}>浏览器未能缓存修改。请先保存，再刷新或关闭页面。</p>:null;
}
export function usePageState<T>(key:string,schema:z.ZodType<T>,fallback:T,owner?:string|null){
  const contextIdentity=useContext(PageIdentity),identity=owner===undefined?contextIdentity:owner;
  const scope=JSON.stringify([identity,key]);
  const [state,setState]=useState(()=>({scope,value:identity?readPageState(identity,key,schema,fallback):fallback}));
  const value=state.scope===scope?state.value:identity?readPageState(identity,key,schema,fallback):fallback;
  if(state.scope!==scope)setState({scope,value});
  const current=useRef(value);current.current=value;
  const update=useCallback((next:SetStateAction<T>)=>{
    const result=typeof next==='function'?(next as (value:T)=>T)(current.current):next;
    current.current=result;
    // Persist synchronously with the edit, not in an unmount/effect that can lose
    // the last keystroke. No request or authorization is ever replayed here.
    if(identity)writePageState(identity,key,result);setState({scope,value:result});
  },[identity,key,scope]);
  return [value,update] as const;
}

// Mutation receipts must survive navigation too: retrying unchanged input uses
// its original request ID. This ref deliberately never initiates a request.
export function usePageRef<T>(key:string,schema:z.ZodType<T>,fallback:T,owner?:string|null){
  const contextIdentity=useContext(PageIdentity),identity=owner===undefined?contextIdentity:owner;
  return useMemo(()=>{
    let value=identity?readPageState(identity,key,schema,fallback):fallback;
    return {get current(){return value;},set current(next:T){value=next;if(identity)writePageState(identity,key,next);}};
  },[identity,key]);
}
