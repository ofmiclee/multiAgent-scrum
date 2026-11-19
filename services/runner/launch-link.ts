import {hostname} from 'node:os';
import {lstat} from 'node:fs/promises';
import {z} from 'zod';
import {defaultDeviceRoot,loadDeviceIdentity} from './device-identity.ts';
import {readDeviceConfig,saveDeviceConfig} from './device-config.ts';
import {localDeviceServer,sendDeviceRequest} from './device-client.ts';
import {TaskJournal} from './task-journal.ts';

/** A registered scheme is not trusted input. Packaged origin pins the receiver
 * before any identity write, credential read or network access. */
export function parseRunnerLaunch(value:string,allowedOrigin:string):{server:string;ticket:string}{
  if(value.length>2048||/[\s\p{Cc}\\]/u.test(value)||localDeviceServer(allowedOrigin)!==allowedOrigin)throw Error('Invalid Runner link');
  const url=new URL(value),entries=[...url.searchParams];
  if(url.protocol!=='mas-runner:'||url.host!=='connect'||url.username||url.password||url.pathname||url.hash||
    entries.length!==2||new Set(entries.map(([key])=>key)).size!==2||entries.some(([key])=>!['server','ticket'].includes(key)))throw Error('Invalid Runner link');
  const server=url.searchParams.get('server'),ticket=url.searchParams.get('ticket');
  if(server!==allowedOrigin||!ticket||!/^[a-f0-9]{64}$/.test(ticket))throw Error('Invalid Runner link');
  return {server,ticket};
}

/** Native app startup resumes only an existing configuration pinned to this
 * package origin. Provider profiles retain their separate local consent gates. */
export async function readRetainedConnection(allowedOrigin:string,root=defaultDeviceRoot()){
  if(localDeviceServer(allowedOrigin)!==allowedOrigin)throw Error('Invalid package configuration');
  const saved=await readDeviceConfig(root);
  if(!saved)return undefined;
  if(saved.server!==allowedOrigin)throw Error('Runner endpoint migration requires explicit consent');
  return saved;
}

export async function attachRunnerLaunch(value:string,allowedOrigin:string,root=defaultDeviceRoot()){
  const {server,ticket}=parseRunnerLaunch(value,allowedOrigin);
  const saved=await readRetainedConnection(server,root);
  let exists=false;
  try{await lstat(root);exists=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(exists){
    const journal=await new TaskJournal(root).inspect();
    if(journal.server&&journal.server!==server)throw Error('Runner journal endpoint mismatch');
  }
  const identity=await loadDeviceIdentity(root);
  if(!saved)await saveDeviceConfig(root,{version:1,server,name:hostname().slice(0,80),profile:'connection'});
  await new TaskJournal(root,server).initialize();
  const reply=await sendDeviceRequest(server,'/api/runner/launch/attach',{ticket,runnerId:identity.runnerId,name:saved?.name??hostname().slice(0,80)},identity.credential,AbortSignal.timeout(8000));
  return z.object({ok:z.literal(true),verificationCode:z.string().regex(/^[A-Z0-9-]{4,32}$/),launchId:z.uuid()}).strict().parse(reply);
}
