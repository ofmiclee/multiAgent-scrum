import {spawn,execFile,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {basename,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {createZstdDecompress} from 'node:zlib';
import {z} from 'zod';
import {listCodexLocalThreads} from '../../packages/executors/codex.ts';

const execute=promisify(execFile);
const uuid=z.uuid();
const provider=z.enum(['codex','claude','codebuddy','dsh']);
export const sessionSendSchema=z.object({provider,id:uuid,requestId:uuid,prompt:z.string().trim().min(1).max(8000)}).strict();
export type LocalSession={provider:z.infer<typeof provider>;id:string;cwd:string;title:string;updatedAt:number;state:'idle'|'active'|'unknown';canResume:boolean};
type AccountState='ready'|'configured'|'unavailable'|'unknown';
type Operation={id:string;requestId:string;provider:z.infer<typeof provider>;sessionId:string;prompt:string;state:'running'|'done'|'failed'|'cancelled';result:string;startedAt:number;
  // Tail buffer of the live process stdout, exposed only to the already-authenticated local owner.
  output:string;outputTruncated:boolean;
  // Parsed model reasoning extracted from the stdout stream, shown live to the local owner.
  thinking:string;thinkingTruncated:boolean;child?:ChildProcessWithoutNullStreams;timer?:NodeJS.Timeout;closed?:Promise<void>};
const OUTPUT_TAIL_LIMIT=16_384;
const THINKING_TAIL_LIMIT=8_000;
const safeEnvironment=()=>Object.fromEntries(['PATH','HOME','CODEX_HOME','TMPDIR','LANG','LC_ALL'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!]]));

async function executable(candidates:string[]){
  for(const candidate of candidates){
    try{const path=await realpath(candidate),stat=await lstat(path);if(stat.isFile()&&stat.mode&0o111)return path;}catch{/* Optional installed CLI. */}
  }
  return null;
}
async function providerCommands(codexCommand?:string,codebuddyCommand?:string){
  const home=homedir();
  return {
    codex:await executable([codexCommand??'', '/opt/homebrew/bin/codex','/usr/local/bin/codex',join(home,'.local/bin/codex')].filter(Boolean)),
    claude:await executable(['/opt/homebrew/bin/claude','/usr/local/bin/claude',join(home,'.local/bin/claude')]),
    codebuddy:await executable([codebuddyCommand??'',join(home,'.local/bin/codebuddy'),'/opt/homebrew/bin/codebuddy','/usr/local/bin/codebuddy'].filter(Boolean)),
    dsh:await executable(['/opt/homebrew/bin/dsh','/usr/local/bin/dsh',join(home,'.local/bin/dsh')]),
  };
}

/** DSH persists a session header as the first JSONL record inside a zstd file.
 * Read only that header, with a hard byte limit; never expose the transcript. */
export async function listDshSessionMetadata(base:string):Promise<LocalSession[]>{
  let projects;try{projects=await readdir(base,{withFileTypes:true});}catch{return [];}
  const candidates:{path:string;mtime:number}[]=[];
  for(const project of projects.slice(0,500)){
    if(!project.isDirectory()||project.isSymbolicLink())continue;
    let sessions;try{sessions=await readdir(join(base,project.name),{withFileTypes:true});}catch{continue;}
    for(const session of sessions.slice(0,500)){
      if(!session.isDirectory()||session.isSymbolicLink())continue;
      const path=join(base,project.name,session.name,'session.jsonl.zstd');
      try{const stat=await lstat(path);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0)candidates.push({path,mtime:stat.mtimeMs});}catch{}
    }
  }
  candidates.sort((a,b)=>b.mtime-a.mtime);
  const result:LocalSession[]=[];
  for(const candidate of candidates.slice(0,80)){
    try{
      const file=await open(candidate.path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const first=await new Promise<string>((resolve,reject)=>{
        const source=file.createReadStream({autoClose:false}),decoder=createZstdDecompress();
        let output='',settled=false;
        const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);source.destroy();decoder.destroy();error?reject(error):resolve(output.split('\n')[0]);};
        const timer=setTimeout(()=>finish(Error('DSH header timeout')),2000);
        decoder.on('data',(chunk:Buffer)=>{output+=chunk.toString('utf8');const lineEnd=output.indexOf('\n');if(lineEnd>=0)finish(lineEnd>16_384?Error('DSH header too large'):undefined);else if(output.length>16_384)finish(Error('DSH header too large'));});
        source.once('error',error=>finish(error));decoder.once('error',error=>finish(error));decoder.once('end',()=>finish());source.pipe(decoder);
      }).finally(()=>file.close());
      const header=JSON.parse(first);
      const id=typeof header.id==='string'?header.id.replace(/^session-/,''):'';
      if(header.type!=='session'||!uuid.safeParse(id).success||typeof header.cwd!=='string'||!isAbsolute(header.cwd)||header.cwd.length>2048)continue;
      result.push({provider:'dsh',id,cwd:header.cwd,title:basename(header.cwd)+' · '+id.slice(0,8),updatedAt:candidate.mtime,state:'unknown',canResume:false});
    }catch{/* A corrupt or changing local transcript is skipped. */}
  }
  return result;
}

/** Read bounded metadata from local transcript files. Never return message bodies,
 * tool calls, credential files, or source contents. */
export async function findTranscriptFile(base:string,id:string):Promise<string|null>{
  if(!uuid.safeParse(id).success)return null;
  let folders;
  try{folders=await readdir(base,{withFileTypes:true});}catch{return null;}
  for(const folder of folders.slice(0,500)){
    if(!folder.isDirectory()||folder.isSymbolicLink())continue;
    const path=join(base,folder.name,id+'.jsonl');
    try{
      const stat=await lstat(path);
      if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0)return path;
    }catch{/* Keep scanning project folders. */}
  }
  return null;
}

/** Extract the latest user/assistant messages from a local transcript file for the
 * authenticated local owner. Bounded reads only; tool calls, attachments, reasoning
 * records, and source contents are never returned. */
export async function readTranscriptMessages(path:string,kind:'claude'|'codebuddy',limit=50):Promise<{messages:{role:'user'|'assistant';text:string;timestamp:number}[];truncated:boolean}>{
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink())return {messages:[],truncated:false};
  // Large transcripts are read from the tail only.
  const tailStart=stat.size>2_000_000?stat.size-2_000_000:0;
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  const messages:{role:'user'|'assistant';text:string;timestamp:number}[]=[];
  let truncated=false;
  try{
    let pending='';
    for await(const chunk of file.createReadStream({start:tailStart,autoClose:false})){
      pending+=chunk.toString('utf8');
      let index;
      while((index=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,index);pending=pending.slice(index+1);
        if(!line||line.length>64_000)continue;
        let row:Record<string,unknown>;try{row=JSON.parse(line);}catch{continue;}
        const message=kind==='claude'?claudeMessage(row):codebuddyMessage(row);
        if(message)messages.push(message);
      }
    }
    if(pending.trim()){
      if(pending.length<=64_000){try{const row=JSON.parse(pending);const message=kind==='claude'?claudeMessage(row):codebuddyMessage(row);if(message)messages.push(message);}catch{}}
    }
  }finally{await file.close();}
  const bounded=messages.slice(-limit);
  if(bounded.length!==messages.length)truncated=true;
  return {messages:bounded.map(row=>row.text.length>8000?(truncated=true,{...row,text:row.text.slice(0,8000)+'…'}):row),truncated};
}

function claudeMessage(row:Record<string,unknown>):{role:'user'|'assistant';text:string;timestamp:number}|null{
  if(row.isSidechain===true)return null;
  const type=row.type;
  if(type!=='user'&&type!=='assistant')return null;
  const content=row.message&&typeof row.message==='object'?(row.message as {content?:unknown}).content:undefined;
  let text='';
  if(typeof content==='string')text=content;
  else if(Array.isArray(content))for(const part of content){if(part&&typeof part==='object'&&'text' in part&&(part as {type?:string}).type==='text'&&typeof (part as {text?:unknown}).text==='string')text+=(part as {text:string}).text;}
  if(!text.trim())return null;
  const timestamp=typeof row.timestamp==='string'?Date.parse(row.timestamp):typeof row.timestamp==='number'?row.timestamp:0;
  return {role:type,text,timestamp:Number.isFinite(timestamp)?timestamp:0};
}

function codebuddyMessage(row:Record<string,unknown>):{role:'user'|'assistant';text:string;timestamp:number}|null{
  if(row.type!=='message')return null;
  const role=row.role;
  if(role!=='user'&&role!=='assistant')return null;
  let text='';
  if(Array.isArray(row.content))for(const part of row.content){if(part&&typeof part==='object'&&'text' in part&&typeof (part as {text?:unknown}).text==='string'){const type=(part as {type?:string}).type;if(type==='input_text'||type==='output_text')text+=(part as {text:string}).text;}}
  else if(typeof row.content==='string')text=row.content;
  if(!text.trim())return null;
  const timestamp=typeof row.timestamp==='number'?row.timestamp:0;
  return {role,text,timestamp:Number.isFinite(timestamp)?timestamp:0};
}

export async function listTranscriptMetadata(base:string,kind:'claude'|'codebuddy'):Promise<LocalSession[]>{
  let folders;
  try{folders=await readdir(base,{withFileTypes:true});}catch{return [];}
  const candidates:{path:string;id:string;mtime:number}[]=[];
  for(const folder of folders.slice(0,500)){
    if(!folder.isDirectory()||folder.isSymbolicLink())continue;
    const directory=join(base,folder.name);
    let files;try{files=await readdir(directory,{withFileTypes:true});}catch{continue;}
    for(const file of files.slice(0,500)){
      if(!file.isFile()||file.isSymbolicLink()||!file.name.endsWith('.jsonl'))continue;
      const id=file.name.slice(0,-6);if(!uuid.safeParse(id).success)continue;
      const path=join(directory,file.name);let stat;try{stat=await lstat(path);}catch{continue;}
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1)continue;
      candidates.push({path,id,mtime:stat.mtimeMs});
    }
  }
  candidates.sort((a,b)=>b.mtime-a.mtime);
  const result:LocalSession[]=[];
  for(const candidate of candidates.slice(0,80)){
    let file;try{file=await open(candidate.path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{continue;}
    try{
      const buffer=Buffer.alloc(32_768),{bytesRead}=await file.read(buffer,0,buffer.length,0);
      let cwd:string|undefined,title:string|undefined;
      for(const line of buffer.subarray(0,bytesRead).toString('utf8').split('\n').slice(0,30)){
        if(!line||line.length>16_384)continue;
        let row:Record<string,unknown>;try{row=JSON.parse(line);}catch{continue;}
        if(typeof row.cwd==='string'&&isAbsolute(row.cwd)&&row.cwd.length<=2048)cwd=row.cwd;
        if(kind==='codebuddy'&&row.type==='ai-title'&&typeof row.aiTitle==='string')title=row.aiTitle.slice(0,120);
        if(cwd&&title)break;
      }
      if(!cwd)continue;
      result.push({provider:kind,id:candidate.id,cwd,title:title||basename(cwd)+' · '+candidate.id.slice(0,8),updatedAt:candidate.mtime,state:'unknown',canResume:false});
    }finally{await file.close();}
  }
  return result;
}

function messageText(content:unknown){
  if(!Array.isArray(content))return '';
  let text='';
  for(const part of content){if(part&&typeof part==='object'&&(part as {type?:string}).type!=='thinking'&&typeof (part as {text?:unknown}).text==='string')text+=(part as {text:string}).text;}
  return text;
}

/** Extract the final reply from a stream-json event log (Claude Code / CodeBuddy). */
function streamJsonResult(output:string){
  let result='',text='';
  for(const line of output.split('\n')){
    if(!line)continue;
    let row:Record<string,unknown>;try{row=JSON.parse(line);}catch{continue;}
    if(row.type==='result'&&typeof row.result==='string')result=row.result;
    if(row.type==='assistant')text=messageText((row.message as {content?:unknown})?.content)||text;
    if(row.type==='message'&&row.role==='assistant')text=messageText(row.content)||text;
  }
  return result||text;
}

/** Extract the final reply from a batch --output-format json payload (event array or result object). */
function batchJsonResult(output:string){
  try{
    const parsed:unknown=JSON.parse(output);
    if(Array.isArray(parsed)){
      let result='',text='';
      for(const row of parsed as Record<string,unknown>[]){
        if(row?.type==='result'&&typeof row.result==='string')result=row.result;
        if(row?.type==='message'&&row.role==='assistant')text=messageText(row.content)||text;
      }
      return result||text;
    }
    if(parsed&&typeof parsed==='object'&&typeof (parsed as {result?:unknown}).result==='string')return (parsed as {result:string}).result;
  }catch{/* Not a batch JSON payload. */}
  return '';
}

function finalText(providerName:string,output:string){
  if(providerName==='codex'){
    let last='';for(const line of output.split('\n')){try{const row=JSON.parse(line);if(row.type==='item.completed'&&row.item?.type==='agent_message'&&typeof row.item.text==='string')last=row.item.text;}catch{}}
    return last.slice(0,12_000);
  }
  if(providerName==='claude'||providerName==='codebuddy'){
    const found=streamJsonResult(output)||batchJsonResult(output);
    if(found)return found.slice(0,12_000);
  }
  try{const row=JSON.parse(output);if(typeof row.result==='string')return row.result.slice(0,12_000);}catch{}
  return output.slice(-12_000);
}

/** Pull model reasoning out of one streamed stdout line, so the web view can show it live. */
function liveThinking(providerName:string,line:string):string{
  if(providerName==='codex'){
    try{const row=JSON.parse(line);if(row.type==='item.completed'&&row.item?.type==='reasoning'&&typeof row.item.text==='string')return row.item.text;}catch{}
    return '';
  }
  try{
    const row=JSON.parse(line);
    const content=row.type==='assistant'?(row.message as {content?:unknown})?.content:undefined;
    if(Array.isArray(content)){let thinking='';for(const part of content){if(part&&typeof part==='object'&&(part as {type?:string}).type==='thinking'&&typeof (part as {thinking?:unknown}).thinking==='string')thinking+=(part as {thinking:string}).thinking;}return thinking;}
  }catch{}
  return '';
}

export class NativeSessionService {
  private operations=new Map<string,Operation>();
  private preparing=false;
  private closing=false;
  private commands:Awaited<ReturnType<typeof providerCommands>>|null=null;
  constructor(private options:{codexCommand?:string;codebuddyCommand?:string;home?:string;dshConfigured?:()=>Promise<boolean>}={}){}
  private async binaries(){return this.commands??=await providerCommands(this.options.codexCommand,this.options.codebuddyCommand);}
  async list(){
    const commands=await this.binaries(),home=this.options.home??homedir();
    const accounts:Record<z.infer<typeof provider>,{installed:boolean;status:AccountState}>={
      codex:{installed:!!commands.codex,status:'unknown'},claude:{installed:!!commands.claude,status:'unknown'},codebuddy:{installed:!!commands.codebuddy,status:'unknown'},dsh:{installed:!!commands.dsh,status:'unknown'},
    };
    const results:LocalSession[]=[];
    if(commands.codex){
      try{
        const found=await listCodexLocalThreads({command:commands.codex});
        accounts.codex.status=found.account?'ready':'unavailable';
        for(const row of found.threads){
          if(!uuid.safeParse(row.id).success||!isAbsolute(row.cwd)||row.cwd.length>2048)continue;
          const state=row.status&&typeof row.status==='object'&&'type' in row.status?(row.status as {type:string}).type:'unknown';
          results.push({provider:'codex',id:row.id,cwd:row.cwd,title:(row.name||row.preview||basename(row.cwd)).slice(0,120),updatedAt:row.updatedAt*1000,state:state==='active'?'active':state==='idle'||state==='notLoaded'?'idle':'unknown',canResume:state==='idle'||state==='notLoaded'});
        }
      }catch{accounts.codex.status='unknown';}
    }
    if(commands.claude){
      try{const {stdout}=await execute(commands.claude,['auth','status'],{timeout:5000,maxBuffer:4096,env:safeEnvironment()});accounts.claude.status=JSON.parse(stdout)?.loggedIn===true?'ready':'unavailable';}
      catch{accounts.claude.status='unavailable';}
      results.push(...await listTranscriptMetadata(join(home,'.claude/projects'),'claude'));
    }
    if(commands.codebuddy){
      const stored=await listTranscriptMetadata(join(home,'.codebuddy/projects'),'codebuddy');
      try{
        const {stdout}=await execute(commands.codebuddy,['ps','--json'],{timeout:5000,maxBuffer:128_000,env:safeEnvironment()});
        const live=JSON.parse(stdout);
        if(Array.isArray(live))for(const row of stored){row.state='idle';row.canResume=true;}
        if(Array.isArray(live))for(const item of live){
          if(!item||typeof item!=='object'||typeof item.sessionId!=='string')continue;
          const match=stored.find(row=>row.id===item.sessionId);
          if(match){match.state='active';match.canResume=false;}
        }
        if(Array.isArray(live)&&live.length)accounts.codebuddy.status='ready';
      }catch{/* Existing transcripts remain available without a live server. */}
      results.push(...stored);
    }
    if(commands.dsh){
      results.push(...await listDshSessionMetadata(join(home,'.dsh/sessions')));
      try{
        const stat=await lstat(join(home,'.dsh/.credentials.yaml'));
        if(stat.isFile()&&!stat.isSymbolicLink()&&!(stat.mode&0o077)&&stat.uid===process.getuid?.())accounts.dsh.status='configured';
      }catch{/* No native DSH credential store. */}
      try{if(await this.options.dshConfigured?.())accounts.dsh.status='ready';}catch{/* Runner credential state remains unknown. */}
    }
    results.sort((a,b)=>b.updatedAt-a.updatedAt);
    return {accounts,projects:[...new Set(results.map(row=>row.cwd))].slice(0,80),sessions:results.slice(0,100)};
  }
  async send(raw:unknown){
    const input=sessionSendSchema.parse(raw);
    const previous=[...this.operations.values()].find(row=>row.requestId===input.requestId);
    if(previous){if(previous.provider!==input.provider||previous.sessionId!==input.id||previous.prompt!==input.prompt)throw Error('Request identity conflict');return {operationId:previous.id};}
    if(this.closing||this.preparing||[...this.operations.values()].some(row=>row.child))throw Error('Another local session turn is running');
    this.preparing=true;
    try{return await this.start(input);}finally{this.preparing=false;}
  }
  private async start(input:z.infer<typeof sessionSendSchema>){
    const found=(await this.list()).sessions.find(row=>row.provider===input.provider&&row.id===input.id);
    if(!found||!found.canResume)throw Error('Session is unavailable or already active');
    const command=(await this.binaries())[input.provider];if(!command)throw Error('Agent CLI is unavailable');
    const cwd=await realpath(found.cwd);if(!isAbsolute(cwd))throw Error('Session project directory is unavailable');
    if(this.closing)throw Error('Local session service is closing');
    // Claude Code and CodeBuddy stream JSONL with stream-json, so live output and
    // model reasoning stay visible while running. DSH keeps the batch json format.
    // CodeBuddy starts an internal service on a fixed default port and fails hard
    // when another CodeBuddy process owns it (e.g. an open interactive session),
    // so the embedded service gets an ephemeral port via --port 0.
    const args=input.provider==='codex'?['exec','resume','--json',input.id,'-']:input.provider==='dsh'?['-r',input.id,'-p','--output-format','json']:input.provider==='codebuddy'?['-r',input.id,'-p','--port','0','--output-format','stream-json']:['-r',input.id,'-p','--output-format','stream-json'];
    const child=spawn(command,args,{cwd,env:safeEnvironment(),stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
    for(const row of this.operations.values())if(row.state!=='running'&&Date.now()-row.startedAt>60*60_000)this.operations.delete(row.id);
    if(this.operations.size>=20)for(const row of this.operations.values()){if(row.state!=='running'){this.operations.delete(row.id);break;}}
    const operation:Operation={id:randomUUID(),requestId:input.requestId,provider:input.provider,sessionId:input.id,prompt:input.prompt,state:'running',result:'',startedAt:Date.now(),output:'',outputTruncated:false,thinking:'',thinkingTruncated:false,child};
    this.operations.set(operation.id,operation);
    child.stdin.on('error',()=>{this.stopProcess(operation);});
    child.stdin.end(input.prompt+'\n');
    let output='',size=0,pending='';
    child.stdout.on('data',(chunk:Buffer)=>{
      size+=chunk.length;
      if(size>512_000){operation.state='failed';operation.result='本机会话输出超过限制。';this.stopProcess(operation);return;}
      const text=chunk.toString('utf8');
      output+=text;
      operation.output=output.length>OUTPUT_TAIL_LIMIT?(operation.outputTruncated=true,output.slice(-OUTPUT_TAIL_LIMIT)):output;
      pending+=text;
      let index;
      while((index=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,index);pending=pending.slice(index+1);
        const thinking=liveThinking(input.provider,line);
        if(thinking){operation.thinking=(operation.thinking+thinking).length>THINKING_TAIL_LIMIT?(operation.thinkingTruncated=true,(operation.thinking+thinking).slice(-THINKING_TAIL_LIMIT)):operation.thinking+thinking;}
      }
    });
    child.stdout.on('error',()=>{this.stopProcess(operation);});
    child.stderr.resume();
    child.once('error',()=>{if(operation.state==='running'){operation.state='failed';operation.result='本机 Agent 未能启动。';}});
    child.once('close',code=>{if(operation.timer)clearTimeout(operation.timer);operation.child=undefined;if(operation.state==='running'){operation.state=code===0?'done':'failed';operation.result=code===0?finalText(input.provider,output):'本机 Agent 未能完成这轮操作，请在原生客户端检查登录、权限或会话状态。';}});
    operation.closed=new Promise(resolve=>child.once('close',()=>resolve()));
    operation.timer=setTimeout(()=>{if(operation.state==='running'){this.stopProcess(operation);operation.state='failed';operation.result='本机会话操作超时。';}},10*60_000);
    return {operationId:operation.id};
  }
  async transcript(providerName:z.infer<typeof provider>,id:string,cursor?:string){
    const sessionId=uuid.parse(id);
    if(providerName==='dsh')return {provider:providerName,id:sessionId,messages:[],hasMore:false,nextCursor:null,unavailableReason:'dsh' as const};
    if(providerName==='codex'){
      // Codex stores sessions as rollout files with an unstable on-disk format; do not guess.
      return {provider:providerName,id:sessionId,messages:[],hasMore:false,nextCursor:null,unavailableReason:'codex' as const};
    }
    const home=this.options.home??homedir();
    const base=providerName==='claude'?join(home,'.claude/projects'):join(home,'.codebuddy/projects');
    const path=await findTranscriptFile(base,sessionId);
    if(!path)return {provider:providerName,id:sessionId,messages:[],hasMore:false,nextCursor:null,unavailableReason:providerName};
    // Cursor counts how many newest messages were already delivered; earlier pages walk backwards.
    const consumed=cursor?Number(cursor):0;
    if(!Number.isInteger(consumed)||consumed<0||consumed>10_000)return {provider:providerName,id:sessionId,messages:[],hasMore:false,nextCursor:null,unavailableReason:providerName};
    const {messages:all,truncated}=await readTranscriptMessages(path,providerName,10_000);
    const remaining=all.slice(0,Math.max(0,all.length-consumed));
    const page=remaining.slice(-50);
    const nextConsumed=consumed+page.length;
    return {provider:providerName,id:sessionId,messages:page,hasMore:remaining.length>page.length||truncated,nextCursor:page.length>0&&nextConsumed<all.length?String(nextConsumed):null,truncated:truncated&&page.length===remaining.length};
  }
  status(id:string){const row=this.operations.get(uuid.parse(id));if(!row)throw Error('Session operation not found');return {operationId:row.id,state:row.state,result:row.result,startedAt:row.startedAt,output:row.output,outputTruncated:row.outputTruncated,thinking:row.thinking,thinkingTruncated:row.thinkingTruncated};}
  cancel(id:string){const row=this.operations.get(uuid.parse(id));if(!row)throw Error('Session operation not found');if(row.state==='running'){this.stopProcess(row);row.state='cancelled';row.result='已请求停止本轮操作。';}return this.status(id);}
  async close(){this.closing=true;for(const row of this.operations.values())if(row.child)this.stopProcess(row);await Promise.all([...this.operations.values()].map(row=>row.closed));}
  private stopProcess(row:Operation){if(!row.child?.pid)return;try{if(process.platform!=='win32')process.kill(-row.child.pid,'SIGKILL');else row.child.kill('SIGKILL');}catch{/* Process may already have exited. */}}
}
