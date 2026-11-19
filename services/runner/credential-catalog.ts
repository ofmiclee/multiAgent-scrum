import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {CodexConnection} from './codex-connection.ts';
import {DshConnection} from './dsh-connection.ts';
import type {DeviceCodexConfig} from './device-codex.ts';

export const credentialMetadataSchema=z.object({
  id:z.uuid(),profile:z.enum(['codex-code','dsh-text']),kind:z.enum(['subscription','api-key']),
  label:z.string().trim().min(1).max(80).refine(value=>!/@|\b(?:sk|ds|key)[-_][A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,}/i.test(value),'Credential label may not contain an email or secret'),
}).strict().refine(value=>value.profile!=='dsh-text'||value.kind==='api-key');
export type CredentialMetadata=z.infer<typeof credentialMetadataSchema>;
const catalogSchema=z.object({version:z.literal(1),credentials:z.array(credentialMetadataSchema).max(38)}).strict();
const filename='credential-catalog.json';

export async function readCredentialCatalog(root:string):Promise<CredentialMetadata[]>{
  let file;
  try{file=await open(join(root,filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  try{
    const info=await file.stat();
    if(!info.isFile()||info.nlink!==1||info.mode&0o077||info.uid!==process.getuid?.()||info.size>16_384)throw Error('Unsafe credential catalog');
    const value=catalogSchema.parse(JSON.parse(await file.readFile('utf8')));
    if(new Set(value.credentials.map(item=>item.id)).size!==value.credentials.length)throw Error('Duplicate credential ID');
    return value.credentials;
  }finally{await file.close();}
}

async function appendCredential(root:string,item:CredentialMetadata){
  const existing=await readCredentialCatalog(root);
  if(existing.length>=38)throw Error('Credential catalog full');
  const temporary=join(root,'.credential-catalog-'+randomUUID());
  await writeFile(temporary,JSON.stringify({version:1,credentials:[...existing,item]}),{mode:0o600,flag:'wx',flush:true});
  await rename(temporary,join(root,filename));
}

/** Must run under the device lock. A new key never changes the shared Codex subscription. */
export async function addCodexApiKey(root:string,owner:string,config:DeviceCodexConfig,label:string,key:string,backend?:ConstructorParameters<typeof CodexConnection>[3]){
  const item=credentialMetadataSchema.parse({id:randomUUID(),profile:'codex-code',kind:'api-key',label});
  const directory=join(root,'codex-keys',item.id);
  await mkdir(directory,{recursive:true,mode:0o700});
  const account=new CodexConnection(directory,owner,config,backend);
  await account.initialize();
  try{
    await account.connectApiKey(key);
    await appendCredential(root,item);
    return item;
  }finally{await account.close();}
}

/** An existing private legacy key can coexist with the one shared local subscription. */
export async function addCodexSubscription(root:string,owner:string,config:DeviceCodexConfig,backend?:ConstructorParameters<typeof CodexConnection>[3],replace=false){
  const existing=(await readCredentialCatalog(root)).find(item=>item.profile==='codex-code'&&item.kind==='subscription');
  const item=existing??credentialMetadataSchema.parse({id:randomUUID(),profile:'codex-code',kind:'subscription',label:'本机 Codex 订阅'});
  const directory=join(root,'codex-subscriptions',item.id);
  await mkdir(directory,{recursive:true,mode:0o700});
  const account=new CodexConnection(directory,owner,config,backend);
  await account.initialize();
  try{if(replace&&account.available(owner))await account.disconnect(async()=>{});if(!account.available(owner))await account.connectLocal();if(!existing)await appendCredential(root,item);return item;}
  finally{await account.close();}
}

/** DSH stores each key in its own private file; the existing key remains intact. */
export async function addDshApiKey(root:string,owner:string,runtime:string,label:string,key:string){
  const item=credentialMetadataSchema.parse({id:randomUUID(),profile:'dsh-text',kind:'api-key',label});
  const directory=join(root,'dsh-keys');await mkdir(directory,{recursive:true,mode:0o700});
  const file=join(directory,item.id+'.json');
  await writeFile(file,JSON.stringify({version:1,refs:{DEEPSEEK_API_KEY:key}}),{mode:0o600,flag:'wx',flush:true});
  const account=await openDshKey(root,owner,runtime,item.id);
  try{await account.connectLocal();await appendCredential(root,item);return item;}
  finally{await account.close();}
}

export async function openCodexCredential(root:string,owner:string,config:DeviceCodexConfig,item:CredentialMetadata){
  if(item.profile!=='codex-code')throw Error('Invalid Codex credential profile');
  const directory=item.kind==='subscription'?'codex-subscriptions':'codex-keys';
  const account=new CodexConnection(join(root,directory,z.uuid().parse(item.id)),owner,config);
  await account.initialize();return account;
}

export async function openDshKey(root:string,owner:string,runtime:string,id:string){
  const account=new DshConnection(join(root,'dsh-accounts',z.uuid().parse(id)),owner,
    {runtime,credentials:join(root,'dsh-keys',id+'.json')});
  await account.initialize();return account;
}
