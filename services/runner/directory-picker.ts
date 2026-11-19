import {execFile as execFileCallback} from 'node:child_process';
import {isAbsolute,resolve} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import type {DeviceIdentity} from './device-identity.ts';
import {DeviceResponseError,localDeviceServer,sendDeviceRequest} from './device-client.ts';

const execute=promisify(execFileCallback);
type PickerResult={result:'selected';directory:string}|{result:'cancelled'|'unavailable'};
type PickerCommand=(file:string,args:string[],options:{signal:AbortSignal;timeout:number;maxBuffer:number;env:NodeJS.ProcessEnv})=>Promise<{stdout:string}>;
const directory=z.string().min(2).max(1024).refine(value=>isAbsolute(value)&&resolve(value)===value&&value!=='/'&&!/[\x00-\x1f\x7f]/.test(value));

/** The fixed AppleScript opens the OS folder chooser; no Web-supplied script or path is executed. */
export async function chooseLocalDirectory(signal:AbortSignal,run:PickerCommand=execute,platform=process.platform):Promise<PickerResult>{
  if(platform!=='darwin')return {result:'unavailable'};
  try{
    signal.throwIfAborted();
    const {stdout}=await run('/usr/bin/osascript',['-e','POSIX path of (choose folder with prompt "选择本机工作目录")'],{
      signal,timeout:8*60_000,maxBuffer:4096,env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin',LANG:process.env.LANG??'zh_CN.UTF-8'},
    });
    const chosen=stdout.trim().replace(/\/+$/,'');
    return directory.safeParse(chosen).success?{result:'selected',directory:chosen}:{result:'unavailable'};
  }catch(error){
    if(signal.aborted||/\(-128\)/.test(String((error as {stderr?:unknown}).stderr??'')))return {result:'cancelled'};
    return {result:'unavailable'};
  }
}

const reply=z.object({job:z.object({id:z.uuid()}).strict().nullable()}).strict();
const ok=z.object({ok:z.literal(true)}).strict();
type Active={id:string;sessionId:string;controller:AbortController;promise:Promise<PickerResult>;result?:PickerResult};

/** A pending native dialog never blocks Runner heartbeats or task polling. */
export class DirectoryPickWorker{
  private active?:Active;
  private base:string;
  constructor(private options:{server:string;identity:DeviceIdentity;choose?:(signal:AbortSignal)=>Promise<PickerResult>}){
    this.base=localDeviceServer(options.server);
  }
  private call(action:string,sessionId:string,body:object={}){
    return sendDeviceRequest(this.base,'/api/runner/project-setup/'+action,
      {runnerId:this.options.identity.runnerId,sessionId,...body},this.options.identity.credential,AbortSignal.timeout(action==='directory-poll'?750:5000));
  }
  async step(sessionId:string){
    const active=this.active;
    if(active){
      if(active.sessionId!==sessionId){active.controller.abort();this.active=undefined;return;}
      if(!active.result)return;
      try{
        ok.parse(await this.call('directory-finish',sessionId,{id:active.id,...active.result}));
        this.active=undefined;
      }catch(error){if(error instanceof DeviceResponseError&&[404,409].includes(error.status))this.active=undefined;else throw error;}
      return;
    }
    let response:z.infer<typeof reply>;
    try{response=reply.parse(await this.call('directory-poll',sessionId));}
    catch(error){if(error instanceof DeviceResponseError&&[404,503].includes(error.status))return;throw error;}
    if(!response.job)return;
    const controller=new AbortController(),picked:Active={id:response.job.id,sessionId,controller,promise:Promise.resolve({result:'unavailable'})};
    picked.promise=(this.options.choose??chooseLocalDirectory)(controller.signal).then(result=>{picked.result=result;return result;},()=>{
      const result={result:'unavailable'} as const;picked.result=result;return result;
    });
    this.active=picked;
  }
  async stop(){const active=this.active;this.active=undefined;if(active){active.controller.abort();await active.promise;}}
}
