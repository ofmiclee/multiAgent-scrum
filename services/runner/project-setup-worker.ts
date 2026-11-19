import {execFile as execFileCallback} from 'node:child_process';
import {chmod,lstat,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {projectFileLimit,setupJobSchema,setupResultSchema,type SetupJob} from '../../packages/domain/project-files.ts';
import type {DeviceIdentity} from './device-identity.ts';
import {DeviceResponseError,localDeviceServer,sendDeviceRequest} from './device-client.ts';

const execFile=promisify(execFileCallback);
const response=z.object({job:setupJobSchema.nullable()}).strict();
const ok=z.object({ok:z.literal(true)}).strict();
type Active={job:SetupJob;promise:Promise<'ok'|'local_changes'|'directory_exists'|'unsafe_path'|'git_failed'|'binding_failed'|'cancelled'|'unavailable'>;sessionId:string};

function checkPath(value:string){
  if(!value.startsWith('/')||value.includes('\0')||value==='/'||value.split('/').some(part=>part==='..')||resolve(value)!==value)throw Error('unsafe_path');
}
async function directory(path:string){
  const value=await lstat(path);if(!value.isDirectory()||value.isSymbolicLink())throw Error('unsafe_path');
}
async function git(destination:string,job:SetupJob){
  const askpass=join(tmpdir(),`mas-askpass-${process.pid}-${Date.now()}`);
  await writeFile(askpass,'#!/bin/sh\ncase "$1" in\n*Username*) printf %s "$MAS_GIT_USERNAME";;\n*) printf %s "$MAS_GIT_TOKEN";;\nesac\n',{mode:0o700});
  try{
    await execFile('git',['clone','--no-recurse-submodules','--config','core.hooksPath=/dev/null','--branch',job.config.branch,job.config.repositoryUrl,destination],{
      cwd:dirname(destination),timeout:120_000,maxBuffer:32*1024,env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??tmpdir(),GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:askpass,MAS_GIT_USERNAME:job.gitUsername,MAS_GIT_TOKEN:job.gitToken},
    });
  }finally{await rm(askpass,{force:true});}
}
async function gitWorkspace(directory:string,repositoryUrl:string){
  try{
    const environment={PATH:process.env.PATH??'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1'};
    const [inside,topLevel,origin,workspace]=await Promise.all([
      execFile('git',['-C',directory,'rev-parse','--is-inside-work-tree'],{timeout:5000,maxBuffer:1024,env:environment}),
      execFile('git',['-C',directory,'rev-parse','--show-toplevel'],{timeout:5000,maxBuffer:4096,env:environment}),
      execFile('git',['-C',directory,'remote','get-url','origin'],{timeout:5000,maxBuffer:4096,env:environment}),
      realpath(directory),
    ]);
    if(inside.stdout.trim()!=='true'||await realpath(topLevel.stdout.trim())!==workspace||origin.stdout.trim()!==repositoryUrl)throw Error();
  }catch{throw Error('binding_failed');}
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const managedSchema=z.object({version:z.number().int().positive(),agentsHash:z.string().regex(/^[a-f0-9]{64}$/),envHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
async function previousManaged(directory:string){
  const value=await readFile(join(directory,'.mas-project-files.json'),'utf8').catch(()=>null);
  if(value===null)return null;
  try{return managedSchema.parse(JSON.parse(value));}catch{throw Error('local_changes');}
}
export async function applyProjectSetup(job:SetupJob){
  checkPath(job.directory);await mkdir(dirname(job.directory),{recursive:true,mode:0o700});
  let exists=true;try{await directory(job.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){exists=false;}else throw error;}
  if(!exists){
    // Claim the exact requested path first, so Git never populates a directory
    // that appeared after the initial existence check.
    try{await mkdir(job.directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('directory_exists');throw error;}
    try{await git(job.directory,job);await gitWorkspace(job.directory,job.config.repositoryUrl);}
    catch(error){await rm(job.directory,{recursive:true,force:true});if(error instanceof Error&&error.message==='binding_failed')throw error;throw Error('git_failed');}
  } else if(job.mode==='initialize'&&(await readdir(job.directory)).length===0){
    try{await git(job.directory,job);await gitWorkspace(job.directory,job.config.repositoryUrl);}
    catch(error){if(error instanceof Error&&error.message==='binding_failed')throw error;throw Error('git_failed');}
  } else await gitWorkspace(job.directory,job.config.repositoryUrl);
  const agents=join(job.directory,'AGENTS.md'),env=join(job.directory,'.deploy-access.env');
  const previous=await previousManaged(job.directory);
  if(job.mode==='sync'&&!previous)throw Error('local_changes');
  if(previous){
    const [oldAgents,oldEnv]=await Promise.all([readFile(agents,'utf8').catch(()=>null),readFile(env,'utf8').catch(()=>null)]);
    if(oldAgents===null||oldEnv===null||digest(oldAgents)!==previous.agentsHash||digest(oldEnv)!==previous.envHash)throw Error('local_changes');
  }
  for(const [path,content,mode] of [[agents,job.agentsMd,0o644],[env,job.env,0o600]] as const){
    await writeFile(path,content,{mode});await chmod(path,mode);
  }
  const exclude=join(job.directory,'.git','info','exclude');
  await mkdir(dirname(exclude),{recursive:true,mode:0o700});
  const current=await readFile(exclude,'utf8').catch(()=>''),lines=new Set(current.split(/\r?\n/).filter(Boolean));
  lines.add('.deploy-access.env');lines.add('.mas-project-files.json');
  await writeFile(exclude,[...lines].join('\n')+'\n',{mode:0o600});
  await writeFile(join(job.directory,'.mas-project-files.json'),JSON.stringify({version:job.version,agentsHash:digest(job.agentsMd),envHash:digest(job.env)})+'\n',{mode:0o600});
  return 'ok' as const;
}

export class ProjectSetupWorker {
  private active:Active|undefined;
  constructor(private options:{server:string;identity:DeviceIdentity}){}
  private call(path:string,body:object,signal=AbortSignal.timeout(5000)){return sendDeviceRequest(localDeviceServer(this.options.server),path,body,this.options.identity.credential,signal,projectFileLimit);}
  async step(sessionId:string){
    if(this.active){
      if(this.active.sessionId!==sessionId)return;
      try{await ok.parse(await this.call('/api/runner/project-setup/renew',{runnerId:this.options.identity.runnerId,sessionId,id:this.active.job.id}));}
      catch{return;}
      if(this.active.promise) {
        const finished=await Promise.race([this.active.promise.then(value=>({value})),new Promise<null>(resolve=>setTimeout(()=>resolve(null),0))]);
        if(!finished)return;
        const result=setupResultSchema.parse(finished.value);
        await ok.parse(await this.call('/api/runner/project-setup/finish',{runnerId:this.options.identity.runnerId,sessionId,id:this.active.job.id,result}));
        this.active=undefined;
      }
      return;
    }
    let reply:z.infer<typeof response>;
    try{reply=response.parse(await this.call('/api/runner/project-setup/poll',{runnerId:this.options.identity.runnerId,sessionId}));}
    catch(error){
      // A Runner can connect to an earlier server during a rolling update.
      if(error instanceof DeviceResponseError&&[404,503].includes(error.status))return;
      throw error;
    }
    if(!reply.job)return;
    const job=reply.job;
    const promise=applyProjectSetup(job).catch(error=>setupResultSchema.parse(error instanceof Error&&setupResultSchema.safeParse(error.message).success?error.message:'unavailable'));
    this.active={job,promise,sessionId};
  }
}
