import {constants} from 'node:fs';
import {open,lstat,rename,unlink} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {loadDeviceIdentity,acquireDeviceLock} from './device-identity.ts';
import {localDeviceServer} from './device-client.ts';
import {TaskJournal} from './task-journal.ts';
import {DshConnection} from './dsh-connection.ts';

const text=z.string().min(1).max(2048).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u);
const path=text.refine(isAbsolute);
const schema=z.object({version:z.literal(1),server:text.transform(localDeviceServer),name:text.max(80),profile:z.enum(['connection','demo','dsh-text','codex-code']),profiles:z.array(z.enum(['dsh-text','codex-code'])).min(1).max(2).optional(),dsh:z.object({runtime:path,credentials:path}).strict().optional(),codex:z.object({command:path,codexHome:path.optional()}).strict().optional()}).strict()
  .refine(c=>c.profile!=='dsh-text'||!!c.dsh)
  .refine(c=>c.profile!=='codex-code'||!!c.codex)
  .refine(c=>!c.profiles||(new Set(c.profiles).size===c.profiles.length&&c.profiles[0]===c.profile&&(!c.profiles.includes('dsh-text')||!!c.dsh)&&(!c.profiles.includes('codex-code')||!!c.codex)));
export type DeviceConfig=z.infer<typeof schema>;

/** Explicit additive local configuration. Account/runtime switches use their
 * dedicated revocation workflow; this operation never rewrites an existing pin. */
export async function configureDeviceProvider(root:string,server:string,provider:'dsh-text'|'codex-code',config:unknown,replaceDshCredential=false):Promise<DeviceConfig>{
  const origin=localDeviceServer(server);
  if(provider!=='dsh-text'&&provider!=='codex-code')throw Error('Unsupported provider');
  const release=await acquireDeviceLock(root);
  try{
    const saved=await readDeviceConfig(root);
    if(!saved||saved.server!==origin)throw Error('Runner endpoint migration requires explicit consent');
    if((await new TaskJournal(root,origin).pending()).length)throw Error('Unsettled work requires local inspection');
    if(saved.profile==='demo')throw Error('Demo profile requires explicit migration');
    const key=provider==='codex-code'?'codex':'dsh';
    const profiles=[...saved.profiles??(saved.profile==='connection'?[]:[saved.profile])];
    if(!profiles.includes(provider))profiles.push(provider);
    const next=schema.parse({...saved,profile:profiles[0],profiles,[key]:config});
    if(saved[key]&&!isDeepStrictEqual(saved[key],next[key])){
      if(!replaceDshCredential||provider!=='dsh-text'||next.dsh?.runtime!==saved.dsh?.runtime||next.dsh?.credentials!==join(root,'dsh-api-key.json'))throw Error('Provider runtime migration requires explicit consent');
      // The explicit native key form may move the MAS pointer only after
      // consent is revoked. Never rewrite the user's external credential file.
      const {runnerId}=await loadDeviceIdentity(root);
      const account=new DshConnection(join(root,'dsh-account'),runnerId,saved.dsh!);
      try{await account.initialize();if(account.view().status!=='disconnected')throw Error('Revoke DSH consent before replacing the credential pointer');}finally{await account.close();}
    }
    if(isDeepStrictEqual(saved,next))return saved;
    const temporary=join(root,'.runner-config-'+randomUUID()),file=await open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify(next));await file.sync();}finally{await file.close();}
    await rename(temporary,join(root,'runner.json'));
    const directory=await open(root,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{await directory.sync();}finally{await directory.close();}
    return next;
  }finally{await release();}
}

/** Read only owned private metadata; corrupt config is never treated as absent. */
export async function readDeviceConfig(root:string):Promise<DeviceConfig|undefined>{
  if(!isAbsolute(root))throw Error('Configuration root must be absolute');
  let dir;try{dir=await lstat(root);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)||dir.uid!==process.getuid?.())throw Error('Unsafe configuration directory');
  let file;try{file=await open(join(root,'runner.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  try{
    const s=await file.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||s.uid!==process.getuid?.()||s.size>8192)throw Error('Unsafe Runner configuration');
    return schema.parse(JSON.parse(await file.readFile('utf8')));
  }finally{await file.close();}
}

/** First-use configuration only. Migration/rewriting must not bypass the journal
 * pin or a native account's separate runtime/credential binding. */
export async function saveDeviceConfig(root:string,value:unknown){
  const config=schema.parse(value);await loadDeviceIdentity(root);const release=await acquireDeviceLock(root);
  try{
    const journal=new TaskJournal(root,config.server);
    if((await journal.pending()).some(p=>!p.terminal))throw Error('Unfinished work requires local inspection');
    const old=await readDeviceConfig(root);
    if(old){if(!isDeepStrictEqual(old,config))throw Error('Runner configuration already exists; explicit migration is required');return;}
    const temporary=join(root,'.runner-config-'+randomUUID()),file=await open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify(config));await file.sync();}finally{await file.close();}
    // All config writers hold the device lock and checked absence above.
    // Rename publishes one readable inode, never a transient two-link file.
    try{await rename(temporary,join(root,'runner.json'));}catch(error){await unlink(temporary).catch(()=>{});throw error;}
    const dir=await open(root,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}
  }finally{await release();}
}

/** Explicit environment values override saved defaults, never grant consent. */
export async function resolveDeviceLaunch(root:string,env:NodeJS.ProcessEnv):Promise<DeviceConfig>{
  const saved=await readDeviceConfig(root);
  const demo=env.MAS_RUNNER_DEMO_TASKS,dsh=env.MAS_RUNNER_DSH_TASKS,codex=env.MAS_RUNNER_CODEX_TASKS;
  for(const flag of [demo,dsh,codex])if(flag!==undefined&&flag!=='0'&&flag!=='1')throw Error('Runner task flags must be 0 or 1');
  if([demo,dsh,codex].filter(flag=>flag==='1').length>1)throw Error('Select one executor profile');
  const profile=demo!==undefined||dsh!==undefined||codex!==undefined?(codex==='1'?'codex-code':dsh==='1'?'dsh-text':demo==='1'?'demo':'connection'):saved?.profile??'connection';
  const runtime=env.MAS_RUNNER_DSH_RUNTIME??saved?.dsh?.runtime,credentials=env.MAS_RUNNER_DSH_CREDENTIAL_STORE??saved?.dsh?.credentials;
  const command=env.MAS_RUNNER_CODEX_COMMAND??saved?.codex?.command,codexHome=env.MAS_RUNNER_CODEX_HOME??saved?.codex?.codexHome;
  return schema.parse({version:1,server:env.MAS_RUNNER_SERVER??saved?.server??'http://127.0.0.1:4317',name:env.MAS_RUNNER_NAME??saved?.name??hostname(),profile,
    ...(demo===undefined&&dsh===undefined&&codex===undefined&&saved?.profiles?{profiles:saved.profiles}:{}),
    ...(runtime!==undefined||credentials!==undefined?{dsh:{runtime,credentials}}:{}),
    ...(command!==undefined||codexHome!==undefined?{codex:{command,...(codexHome!==undefined?{codexHome}:{})}}:{}),
  });
}
