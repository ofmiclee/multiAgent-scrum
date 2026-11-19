import {constants} from 'node:fs';
import {lstat,open,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {readCodexAccount,loginCodex,loginCodexApiKey,logoutCodex,type Options} from '../../packages/executors/codex.ts';
import {CodexConnection,type ConnectionView} from './codex-connection.ts';
import {acquireDeviceLock,loadDeviceIdentity} from './device-identity.ts';
import {DeviceWorkBlocked,localDeviceServer} from './device-client.ts';
import {TaskJournal} from './task-journal.ts';
import {addCodexApiKey,addCodexSubscription} from './credential-catalog.ts';

const path=z.string().min(1).max(2048).refine(isAbsolute);
export const deviceCodexConfigSchema=z.object({command:path,codexHome:path.optional()}).strict();
export type DeviceCodexConfig=z.infer<typeof deviceCodexConfigSchema>;
const resolvedDeviceCodexConfigSchema=z.object({command:path,codexHome:path}).strict();
type ResolvedDeviceCodexConfig=z.infer<typeof resolvedDeviceCodexConfigSchema>;
type Backend={read:typeof readCodexAccount;login:typeof loginCodex;loginApiKey:typeof loginCodexApiKey;logout:typeof logoutCodex};
const runtimeName='runtime.json';

function resolveDeviceCodexConfig(raw:DeviceCodexConfig,environment:NodeJS.ProcessEnv):ResolvedDeviceCodexConfig{
  const config=deviceCodexConfigSchema.parse(raw);
  const codexHome=config.codexHome??(environment.CODEX_HOME!==undefined?environment.CODEX_HOME:environment.HOME===undefined?undefined:join(environment.HOME,'.codex'));
  return resolvedDeviceCodexConfigSchema.parse({...config,codexHome});
}

async function readRuntime(directory:string):Promise<ResolvedDeviceCodexConfig|undefined>{
  let file;try{file=await open(join(directory,runtimeName),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  try{
    const value=await file.stat();if(!value.isFile()||value.nlink!==1||(value.mode&0o077)||value.uid!==process.getuid?.()||value.size>8192)throw Error('Unsafe Codex runtime pin');
    try{return resolvedDeviceCodexConfigSchema.parse(JSON.parse(await file.readFile('utf8')));}catch{throw Error('Invalid Codex runtime pin');}
  }finally{await file.close();}
}
async function pinRuntime(directory:string,config:ResolvedDeviceCodexConfig){
  const existing=await readRuntime(directory);
  if(existing){if(!isDeepStrictEqual(existing,config))throw Error('Codex runtime configuration differs from the consent pin');return;}
  const file=await open(join(directory,runtimeName),'wx',0o600);
  try{await file.writeFile(JSON.stringify(config));await file.sync();}finally{await file.close();}
  const parent=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await parent.sync();}finally{await parent.close();}
}
async function clearRuntime(directory:string){
  const path=join(directory,runtimeName);
  let before;try{before=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const current=await file.stat();if(!current.isFile()||current.nlink!==1||current.dev!==before.dev||current.ino!==before.ino)throw Error('Unsafe Codex runtime pin');await unlink(path);}finally{await file.close();}
}

export async function openDeviceCodex(root:string,owner:string,raw:DeviceCodexConfig,backend?:Backend,environment:NodeJS.ProcessEnv=process.env){
  const config=resolveDeviceCodexConfig(raw,environment),directory=join(root,'codex-account');
  const account=new CodexConnection(directory,owner,config,backend);await account.initialize();
  try{
    const pinned=await readRuntime(directory);
    if((pinned&&!isDeepStrictEqual(pinned,config))||(!pinned&&account.available(owner)))throw Error('Codex runtime configuration does not match committed consent');
    return {account,config,directory,pinned};
  }catch(error){await account.close();throw error;}
}

/** Device-local Codex consent protected by the same lock, journal and server pin as work. */
export async function manageDeviceCodex(options:{root:string;server:string;config:DeviceCodexConfig;action:string;apiKey?:string;signal?:AbortSignal;onLoginUrl?:(url:string)=>void;environment?:NodeJS.ProcessEnv},backend?:Backend){
  options.signal?.throwIfAborted();
  const action=z.enum(['status','detect','use-local','login','login-local','switch-local','api-key','disconnect']).parse(options.action);
  const server=localDeviceServer(options.server),identity=await loadDeviceIdentity(options.root),release=await acquireDeviceLock(options.root);
  let account:CodexConnection|undefined,closing:Promise<void>|undefined;
  let addedCredential:Awaited<ReturnType<typeof addCodexApiKey>>|undefined;
  let accountView:ConnectionView|undefined;
  const abort=()=>{closing=account?.close();void closing?.catch(()=>{});};
  try{
    const journal=new TaskJournal(options.root,server);await journal.initialize();
    if(action!=='status'&&(await journal.pending()).some(item=>!item.terminal))throw new DeviceWorkBlocked('Unfinished task journal requires local process inspection before account changes');
    const opened=await openDeviceCodex(options.root,identity.runnerId,options.config,backend,options.environment);account=opened.account;
    options.signal?.addEventListener('abort',abort,{once:true});options.signal?.throwIfAborted();
    if(action==='login-local'||action==='switch-local'){
      const auth=backend??{read:readCodexAccount,login:loginCodex,loginApiKey:loginCodexApiKey,logout:logoutCodex};
      const privateLegacy=account.view().source==='private';
      if(action==='login-local'&&!privateLegacy&&account.available(identity.runnerId))await account.disconnect(async()=>{});
      if(action==='switch-local'){
        // Only the explicitly confirmed native switch action may log out the
        // shared home. Ordinary disconnect continues to preserve native login.
        if(!privateLegacy){await account.disconnect(async()=>{});await clearRuntime(opened.directory);}
        await auth.logout(opened.config);
      }
      let current=await auth.read(opened.config);
      if(current?.type==='apiKey')throw Error('Shared Codex home uses an API key; choose private API key setup instead');
      if(!current)current=await auth.login(opened.config,options.signal??new AbortController().signal,url=>options.onLoginUrl?.(url));
      options.signal?.throwIfAborted();
      if(!current)throw Error('Codex login did not complete');
      if(privateLegacy){
        addedCredential=await addCodexSubscription(options.root,identity.runnerId,opened.config,backend,action==='switch-local');
        accountView={status:'connected',source:'local',localDetected:true,accountLabel:'本机 Codex 订阅'};
      }else if(!account.available(identity.runnerId)){
        await pinRuntime(opened.directory,opened.config);await account.connectLocal();
      }
    }
    else if(action==='detect'&&!account.available(identity.runnerId))await account.detect();
    else if(action==='use-local'){
      await pinRuntime(opened.directory,opened.config);await account.connectLocal();
    }else if(action==='login'){
      await pinRuntime(opened.directory,opened.config);
      const view=await account.beginLogin();if(view.authUrl)options.onLoginUrl?.(view.authUrl);
      while(account.view().status==='connecting')await delay(10,undefined,{signal:options.signal});
      if(account.view().status!=='connected')throw Error('Codex login did not complete');
    }else if(action==='api-key'){
      if(!options.apiKey)throw Error('Codex API key is required');
      addedCredential=await addCodexApiKey(options.root,identity.runnerId,opened.config,'Codex API Key',options.apiKey,backend);
    }else if(action==='disconnect'){
      await account.disconnect(async()=>{});await clearRuntime(opened.directory);
    }
    if(action!=='use-local'&&action!=='login')options.signal?.throwIfAborted();
    return {runnerId:identity.runnerId,account:accountView??account.view(),...(addedCredential?{credential:addedCredential}:{})};
  }finally{
    options.signal?.removeEventListener('abort',abort);
    try{await closing;await account?.close();}finally{await release();}
  }
}
