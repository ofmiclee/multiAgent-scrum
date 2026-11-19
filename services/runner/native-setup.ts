import {lstat,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {configureDeviceProvider,readDeviceConfig,type DeviceConfig} from './device-config.ts';
import {manageDeviceCodex,type DeviceCodexConfig} from './device-codex.ts';
import {manageDeviceDsh} from './device-dsh.ts';
import {bindCodeRepository,readCodeBindings} from './code-bindings.ts';
import {TaskJournal} from './task-journal.ts';
import {inspectDeviceIdentity,acquireDeviceLock} from './device-identity.ts';
import {addCodexApiKey,addDshApiKey} from './credential-catalog.ts';

const path=z.string().min(1).max(2048).refine(isAbsolute);
const provider=z.enum(['dsh-text','codex-code']);
const request=z.discriminatedUnion('op',[
  z.object({op:z.literal('status')}).strict(),
  z.object({op:z.literal('account-entry'),url:z.string().min(1).max(2048)}).strict(),
  z.object({op:z.literal('prepare-account'),provider}).strict(),
  z.object({op:z.literal('dsh-key'),label:z.string().trim().min(1).max(80).optional(),apiKey:z.string().trim().min(1).max(1024).regex(/^[\x21-\x7e]+$/)}).strict(),
  z.object({op:z.literal('codex-key'),label:z.string().trim().min(1).max(80).optional(),apiKey:z.string().trim().min(1).max(1024).regex(/^[\x21-\x7e]+$/)}).strict(),
  z.object({op:z.literal('configure'),provider,config:z.union([
    z.object({runtime:path,credentials:path}).strict(),
    z.object({command:path,codexHome:path.optional()}).strict(),
  ])}).strict(),
  z.object({op:z.literal('account'),provider,action:z.enum(['detect','use-local','disconnect','login','switch-account'])}).strict(),
  z.object({op:z.literal('bind-code'),projectId:z.uuid(),repository:path,ref:z.string().min(1).max(200)}).strict(),
]);
export type NativeSetupRequest=z.infer<typeof request>;

type DshBackend=Parameters<typeof manageDeviceDsh>[1];
type CodexBackend=Parameters<typeof manageDeviceCodex>[1];
type Options={root:string;allowedOrigin:string;signal?:AbortSignal;dshBackend?:DshBackend;codexBackend?:CodexBackend;onLoginUrl?:(url:string)=>void;bundledDshRuntime?:string;bundledCodexCommand?:string};
const execute=promisify(execFile);

function profiles(config:DeviceConfig):('dsh-text'|'codex-code')[]{
  if(config.profiles)return [...config.profiles];
  return config.profile==='dsh-text'||config.profile==='codex-code'?[config.profile]:[];
}

function safeAccount(view:{status:string;source?:string|null;localDetected?:boolean|null;accountLabel?:string|null}){
  return {status:view.status,source:view.source??null,localDetected:view.localDetected??null,accountLabel:view.accountLabel??null};
}

async function rootExists(root:string){
  try{const value=await lstat(root);return value.isDirectory()&&!value.isSymbolicLink();}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}

async function inspectJournal(root:string){
  const journal=await new TaskJournal(root).inspect();
  if(!journal.exists)return 'absent' as const;
  if(journal.pending.some(item=>!item.terminal))return 'unfinished' as const;
  if(journal.pending.length)return 'receipts' as const;
  return 'settled' as const;
}

async function requireMutable(root:string,allowedOrigin:string){
  const config=await readDeviceConfig(root);
  if(!config||config.server!==allowedOrigin)throw Error('Runner endpoint does not match the packaged origin');
  const journal=await new TaskJournal(root).inspect();
  if(journal.server&&journal.server!==allowedOrigin)throw Error('Runner journal endpoint does not match the packaged origin');
  if(journal.pending.length)throw Error('Pending Runner journal work requires local inspection');
  return config;
}

async function compatibleCodexVersion(command:string){
  let stdout='';
  try{
    const result=await execute(command,['--version'],{timeout:5000,maxBuffer:4096,killSignal:'SIGKILL',encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:process.env.LANG}});
    stdout=result.stdout;
  }catch{throw Error('Codex runtime is unavailable');}
  const match=/\bcodex-cli\s+([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][\w.-]+)?\b/.exec(stdout);
  if(!match)throw Error('Codex runtime version is unavailable');
  const numbers=match.slice(1,4).map(Number),minimum=[0,154,0];
  const difference=numbers.findIndex((value,index)=>value!==minimum[index]);
  const compatible=difference===-1||numbers[difference]!>minimum[difference]!;
  if(!compatible)throw Error('Codex runtime version is not supported');
  return match[1]+'.'+match[2]+'.'+match[3];
}

/** One local native-dialog operation. Web links cannot select commands, paths,
 * accounts or repositories; the package supplies its exact allowed origin. */
export async function runNativeSetupOperation(raw:unknown,options:Options):Promise<any>{
  const input=request.parse(raw);
  if(!isAbsolute(options.root))throw Error('Native Runner root must be absolute');
  options.signal?.throwIfAborted();
  if(input.op==='account-entry'){
    // This untrusted URL only opens a local consent dialog. It cannot supply
    // runtime paths, credentials or an action, and is not proof of Web identity.
    const url=new URL(input.url),keys=[...url.searchParams.keys()];
    if(url.protocol!=='mas-runner:'||url.hostname!=='account'||url.port||url.username||url.password||url.pathname||url.hash||keys.length!==3||new Set(keys).size!==3||!keys.every(key=>['server','runnerId','provider'].includes(key)))throw Error('Invalid account entry');
    if(url.searchParams.get('server')!==options.allowedOrigin)throw Error('Account entry origin mismatch');
    const selectedProvider=provider.parse(url.searchParams.get('provider'));
    const runnerId=z.uuid().parse(url.searchParams.get('runnerId'));
    const identity=await inspectDeviceIdentity(options.root),config=await readDeviceConfig(options.root);
    if(!identity||identity.runnerId!==runnerId||!config||config.server!==options.allowedOrigin)throw Error('Account entry device mismatch');
    return {ok:true,operation:'account-entry',provider:selectedProvider,configured:selectedProvider==='codex-code'?!!config.codex:!!config.dsh};
  }
  if(input.op==='status'){
    if(!await rootExists(options.root))return {ok:true,operation:'status',state:{configured:false,profiles:[],journal:'absent',bindings:[]}};
    const config=await readDeviceConfig(options.root);
    if(!config)return {ok:true,operation:'status',state:{configured:false,profiles:[],journal:await inspectJournal(options.root),bindings:[]}};
    if(config.server!==options.allowedOrigin)throw Error('Runner endpoint does not match the packaged origin');
    const enabled=profiles(config);
    const bindings=(await readCodeBindings(options.root)).map(binding=>({projectId:binding.projectId,repository:binding.repository}));
    return {ok:true,operation:'status',state:{configured:true,profiles:enabled,journal:await inspectJournal(options.root),bindings}};
  }

  const config=await requireMutable(options.root,options.allowedOrigin);
  if(input.op==='prepare-account'){
    if(input.provider==='codex-code'){
      if(!config.codex){
        let command:string|undefined;
        for(const candidate of [options.bundledCodexCommand,'/opt/homebrew/bin/codex','/usr/local/bin/codex',join(homedir(),'.local/bin/codex')].filter((value):value is string=>!!value)){
          try{await compatibleCodexVersion(candidate);command=candidate;break;}catch{/* Try the next known installation, never a URL-supplied executable. */}
        }
        if(!command)return {ok:true,operation:'prepare-account',installed:false};
        await configureDeviceProvider(options.root,options.allowedOrigin,'codex-code',{command});
      }
      return {ok:true,operation:'prepare-account',installed:true};
    }
    return {ok:true,operation:'prepare-account',installed:!!config.dsh||!!await discoverDsh(options.bundledDshRuntime)};
  }
  if(input.op==='dsh-key'){
    const runtime=config.dsh?.runtime??await discoverDsh(options.bundledDshRuntime);
    if(!runtime)throw Error('DSH runtime is not installed');
    const release=await acquireDeviceLock(options.root);
    let credential;
    try{
      await requireMutable(options.root,options.allowedOrigin);
      const identity=await inspectDeviceIdentity(options.root);if(!identity)throw Error('Runner identity is unavailable');
      credential=await addDshApiKey(options.root,identity.runnerId,runtime,input.label??'DSH API Key',input.apiKey);
    }finally{await release();}
    if(!config.dsh)await configureDeviceProvider(options.root,options.allowedOrigin,'dsh-text',{runtime,credentials:join(options.root,'dsh-keys',credential.id+'.json')});
    return {ok:true,operation:'dsh-key',credential};
  }
  if(input.op==='codex-key'){
    let codex=config.codex;
    if(!codex){
      for(const candidate of [options.bundledCodexCommand,'/opt/homebrew/bin/codex','/usr/local/bin/codex',join(homedir(),'.local/bin/codex')].filter((value):value is string=>!!value)){
        try{await compatibleCodexVersion(candidate);codex={command:candidate};break;}catch{/* Try the next installed runtime. */}
      }
      if(!codex)throw Error('Codex runtime is not installed');
      await configureDeviceProvider(options.root,options.allowedOrigin,'codex-code',codex);
    }
    const release=await acquireDeviceLock(options.root);
    try{
      await requireMutable(options.root,options.allowedOrigin);
      const identity=await inspectDeviceIdentity(options.root);if(!identity)throw Error('Runner identity is unavailable');
      const credential=await addCodexApiKey(options.root,identity.runnerId,codex,input.label??'Codex API Key',input.apiKey,options.codexBackend);
      return {ok:true,operation:'codex-key',credential};
    }finally{await release();}
  }
  if(input.op==='configure'){
    if(input.provider==='codex-code'&&!('command' in input.config)||input.provider==='dsh-text'&&!('runtime' in input.config))throw Error('Provider configuration does not match the selected provider');
    const runtime=input.provider==='codex-code'?{version:await compatibleCodexVersion((input.config as DeviceCodexConfig).command)}:undefined;
    const next=await configureDeviceProvider(options.root,options.allowedOrigin,input.provider,input.config);
    return {ok:true,operation:'configure',provider:input.provider,profiles:profiles(next),...(runtime?{runtime}:{})};
  }
  if(input.op==='account'){
    if(input.provider==='codex-code'){
      if(!config.codex)throw Error('Codex is not configured');
      const action=input.action==='login'?'login-local':input.action==='switch-account'?'switch-local':input.action;
      const view=await manageDeviceCodex({root:options.root,server:config.server,config:config.codex as DeviceCodexConfig,action,signal:options.signal,onLoginUrl:options.onLoginUrl},options.codexBackend);
      return {ok:true,operation:'account',provider:input.provider,account:safeAccount(view.account)};
    }
    if(!config.dsh)throw Error('DSH is not configured');
    if(input.action==='login'||input.action==='switch-account')throw Error('DSH uses an API key, not account login');
    const view=await manageDeviceDsh({root:options.root,server:config.server,config:config.dsh,action:input.action,signal:options.signal},options.dshBackend);
    return {ok:true,operation:'account',provider:input.provider,account:safeAccount(view.account)};
  }
  const binding=await bindCodeRepository({root:options.root,server:config.server,projectId:input.projectId,repository:input.repository,ref:input.ref});
  return {ok:true,operation:'bind-code',projectId:binding.projectId,repository:binding.repository};
}

async function discoverDsh(bundled?:string):Promise<string|undefined>{
  for(const candidate of [bundled,...['/opt/homebrew/lib/node_modules/@deepseek-ai/dsh','/usr/local/lib/node_modules/@deepseek-ai/dsh',join(homedir(),'.local/lib/node_modules/@deepseek-ai/dsh')]].filter((p):p is string=>!!p)){
    try{const pkg=JSON.parse(await readFile(join(candidate,'package.json'),'utf8'));if(pkg.name==='@deepseek-ai/dsh'&&pkg.version==='0.1.2-alpha.2')return candidate;}catch{/* No installation at this known path. */}
  }
}

/** Process boundary used by the bundled helper: one request in, one response out. */
export async function runNativeSetupJson(value:string,options:Options){
  if(!value||Buffer.byteLength(value)>8192)throw Error('Invalid native setup request');
  let parsed:unknown;
  try{parsed=JSON.parse(value);}catch{throw Error('Invalid native setup request');}
  const output=JSON.stringify(await runNativeSetupOperation(parsed,options))+'\n';
  if(Buffer.byteLength(output)>32768)throw Error('Native setup response exceeds limit');
  return output;
}
