import {loadDeviceIdentity,acquireDeviceLock} from './device-identity.ts';
import {runDeviceClient,type DeviceEvent} from './device-client.ts';
import {openDeviceExecution} from './device-execution.ts';
import {TaskJournal} from './task-journal.ts';
import {readRetainedConnection} from './launch-link.ts';
import {ProjectSetupWorker} from './project-setup-worker.ts';
import {DirectoryPickWorker} from './directory-picker.ts';
import {openLocalKeyBridge} from './local-key-bridge.ts';
import {readCredentialCatalog} from './credential-catalog.ts';

/** Resume only a previously attached, package-origin-pinned profile. A first
 * app open stays idle. Provider execution still requires retained consent. */
export async function runRetainedConnectionWorker(options:{
  allowedOrigin:string;
  root:string;
  signal:AbortSignal;
  event?:(event:DeviceEvent)=>void;
}):Promise<boolean>{
  const saved=await readRetainedConnection(options.allowedOrigin,options.root);
  if(!saved)return false;
  const identity=await loadDeviceIdentity(options.root),release=await acquireDeviceLock(options.root);
  let execution:Awaited<ReturnType<typeof openDeviceExecution>>|undefined;
  let bridge:Awaited<ReturnType<typeof openLocalKeyBridge>>|undefined;
  try{
    bridge=await openLocalKeyBridge({origin:saved.server,runnerId:identity.runnerId,codexCommand:saved.codex?.command,dshConfigured:async()=>(await readCredentialCatalog(options.root)).some(item=>item.profile==='dsh-text'),add:async(profile,label,key)=>{
      if(!execution?.addApiKey)throw Error('Runner is not ready for account configuration');
      return execution.addApiKey(profile,label,key);
    }});
    const journal=new TaskJournal(options.root,saved.server);await journal.initialize();
    execution=await openDeviceExecution({root:options.root,identity,launch:saved,journal,localConfig:{port:bridge.port,token:bridge.token}});
    const projectSetup=new ProjectSetupWorker({server:saved.server,identity}),picker=new DirectoryPickWorker({server:saved.server,identity});
    await runDeviceClient({server:saved.server,identity,name:saved.name,signal:options.signal,event:options.event??(()=>{}),tasks:execution.tasks,
      setup:{step:async sessionId=>{await picker.step(sessionId);await projectSetup.step(sessionId);},stop:()=>picker.stop()}});
  }finally{
    try{await bridge?.close();}finally{try{await execution?.close();}finally{await release();}}
  }
  return true;
}
