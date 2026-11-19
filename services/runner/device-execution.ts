import type {DeviceConfig} from './device-config.ts';
import type {DeviceIdentity} from './device-identity.ts';
import type {TaskJournal} from './task-journal.ts';
import {TaskWorker,type WorkerProvider} from './task-worker.ts';
import {join} from 'node:path';
import {DshConnection} from './dsh-connection.ts';
import {openDeviceCodex} from './device-codex.ts';
import {readCodeBindings} from './code-bindings.ts';
import {CodeWorkspaceExecutor} from './code-executor.ts';
import {SnapshotStore} from './snapshots.ts';
import {createCodeArtifactTransport} from './code-artifact-transport.ts';
import {prepareCodeRepositories,codeArtifactCapability} from './code-repository-transport.ts';
import {DemoExecutor} from '../../packages/executors/demo.ts';
import {TypeSafeAssessor,typeSafeConfig} from './typesafe-assessor.ts';
import {readCredentialCatalog,openCodexCredential,openDshKey,addCodexApiKey,addDshApiKey} from './credential-catalog.ts';
import {CredentialExecutor} from './credential-executor.ts';
import type {RunnerCredential} from '../../packages/domain/runner-protocol.ts';

/** Caller owns the one device lock and must stop TaskWorker before close.
 * Shared by packaged and CLI hosts; this factory never grants account consent. */
export async function openDeviceExecution(options:{root:string;identity:DeviceIdentity;launch:DeviceConfig;journal:TaskJournal;localConfig?:{port:number;token:string}}):Promise<{tasks?:TaskWorker;accepting():boolean;close():Promise<void>;addApiKey?:(profile:'codex-code'|'dsh-text',label:string,key:string)=>Promise<{id:string;label:string}>}>{
  const {root,identity,launch,journal}=options,accounts:{close():Promise<void>}[]=[];
  let closing:Promise<void>|undefined;
  const close=()=>closing??=Promise.allSettled(accounts.map(account=>account.close())).then(results=>{
    if(results.some(result=>result.status==='rejected'))throw Error('Native account close requires inspection');
  });
  if(launch.profile==='connection')return {accepting:()=>false,close};
  const pending=await journal.pending();
  if(pending.some(item=>!item.terminal))throw Error('Unfinished native task requires local inspection');
  const providers:WorkerProvider[]=[];
  const catalog=await readCredentialCatalog(root);
  const additions=new Map<'codex-code'|'dsh-text',(label:string,key:string)=>Promise<{id:string;label:string}>>();
  let currentSession:string|undefined;
  try{
    const assessor=typeSafeConfig(process.env);
    for(const profile of launch.profiles??[launch.profile]){
      if(profile==='dsh-text'){
        if(process.platform!=='darwin')throw Error('Native DSH text requires macOS containment');
        const account=new DshConnection(join(root,'dsh-account'),identity.runnerId,launch.dsh!);
        accounts.push(account);await account.initialize();
        const connections=new Map<string,DshConnection>([['legacy',account]]);
        for(const item of catalog.filter(item=>item.profile===profile)){
          try{const key=await openDshKey(root,identity.runnerId,launch.dsh!.runtime,item.id);accounts.push(key);connections.set(item.id,key);}
          catch{/* One unavailable credential does not disable other local accounts. */}
        }
        const credentials=():RunnerCredential[]=>[...connections].filter(([,value])=>value.accepting(identity.runnerId)).map(([id])=>({id:id,profile,kind:'api-key',label:id==='legacy'?'本机 DSH API Key':catalog.find(item=>item.id===id)!.label}));
        additions.set(profile,async(label,key)=>{
          const item=await addDshApiKey(root,identity.runnerId,launch.dsh!.runtime,label,key);
          const connection=await openDshKey(root,identity.runnerId,launch.dsh!.runtime,item.id);
          accounts.push(connection);catalog.push(item);connections.set(item.id,connection);
          return {id:item.id,label:item.label};
        });
        const bindings=await readCodeBindings(root);
        const snapshots=new SnapshotStore(join(root,'code-snapshots'));
        const artifacts=createCodeArtifactTransport({server:launch.server,identity,session:()=>currentSession});
        const executor=new CodeWorkspaceExecutor({executor:new CredentialExecutor(connections),snapshots,bindings,artifacts});
        providers.push({profile,executor,credentials,codeBindings:bindings,accepting:()=>credentials().length>0&&executor.accepting(),prepare:async(sessionId,signal)=>{
          const session={server:launch.server,identity,sessionId,signal};
          if(await codeArtifactCapability(session)==='disabled')return;
          await prepareCodeRepositories({...session,snapshots,bindings});
        }});
      }else if(profile==='codex-code'){
        if(process.platform==='win32')throw Error('Native Codex code tasks require a local POSIX host');
        const bindings=await readCodeBindings(root),{account}=await openDeviceCodex(root,identity.runnerId,launch.codex!);
        accounts.push(account);
        const connections=new Map<string,typeof account>([['legacy',account]]);
        for(const item of catalog.filter(item=>item.profile===profile)){
          try{const key=await openCodexCredential(root,identity.runnerId,launch.codex!,item);accounts.push(key);connections.set(item.id,key);}
          catch{/* A missing key remains unready without affecting the subscription. */}
        }
        const credentials=():RunnerCredential[]=>[...connections].filter(([,value])=>value.accepting(identity.runnerId)).map(([id,value])=>({id,profile,kind:id==='legacy'?(value.view().accountLabel==='API Key'?'api-key':'subscription'):catalog.find(item=>item.id===id)!.kind,label:id==='legacy'?(value.view().accountLabel==='API Key'?'现有 Codex API Key':'本机 Codex 订阅'):catalog.find(item=>item.id===id)!.label}));
        additions.set(profile,async(label,key)=>{
          const item=await addCodexApiKey(root,identity.runnerId,launch.codex!,label,key);
          const connection=await openCodexCredential(root,identity.runnerId,launch.codex!,item);
          accounts.push(connection);catalog.push(item);connections.set(item.id,connection);
          return {id:item.id,label:item.label};
        });
        const snapshots=new SnapshotStore(join(root,'code-snapshots'));
        const artifacts=createCodeArtifactTransport({server:launch.server,identity,session:()=>currentSession});
        const executor=new CodeWorkspaceExecutor({executor:new CredentialExecutor(connections),snapshots,bindings,artifacts});
        providers.push({profile,executor,credentials,codeBindings:bindings,accepting:()=>credentials().length>0&&executor.accepting(),prepare:async(sessionId,signal)=>{
          const session={server:launch.server,identity,sessionId,signal};
          if(await codeArtifactCapability(session)==='disabled')return;
          await prepareCodeRepositories({...session,snapshots,bindings});
        }});
      }else providers.push({profile,executor:new DemoExecutor()});
    }
    if(assessor)for(const provider of providers){
      if(provider.profile!=='demo')provider.executor=new TypeSafeAssessor(provider.executor,assessor);
    }
    const first=providers[0];
    const tasks=new TaskWorker({server:launch.server,identity,journal,...first,...(launch.profiles?{providers}:{}),localConfig:options.localConfig,onSession:sessionId=>{currentSession=sessionId;}});
    return {tasks,accepting:()=>providers.some(p=>!p.accepting||p.accepting()),close,
      addApiKey:async(profile,label,key)=>{
        const add=additions.get(profile);if(!add)throw Error('Provider is not configured on this Runner');
        return add(label,key);
      }};
  }catch(error){await close();throw error;}
}
