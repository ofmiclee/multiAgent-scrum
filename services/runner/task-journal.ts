import {constants} from 'node:fs';
import {mkdir,lstat,open,readdir} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {taskRefSchema,terminalSchema,type TaskRef,type TaskTerminal} from '../../packages/domain/runner-protocol.ts';

/** Immutable private write-ahead records. Never delete dedupe tombstones on acknowledgement. */
export class TaskJournal {
  private directory:string;
  constructor(private root:string,private server?:string){if(!isAbsolute(root))throw Error('Journal requires absolute root');this.directory=join(root,'task-journal');}
  async initialize(){
    const parent=await lstat(this.root);
    if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)||parent.uid!==process.getuid?.())throw Error('Journal requires private owned root');
    try{await mkdir(this.directory,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    const s=await lstat(this.directory);
    if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.())throw Error('Journal requires private owned directory');
    const root=await open(this.root,constants.O_RDONLY|constants.O_NOFOLLOW);try{await root.sync();}finally{await root.close();}
    if(this.server)await this.write('scope.json',{server:this.server});
    else if(await this.optional('scope.json')!==undefined)throw Error('Journal scope conflict');
  }
  private key(r:TaskRef){taskRefSchema.parse(r);return createHash('sha256').update(r.attemptId).digest('hex');}
  private async read(name:string):Promise<unknown>{
    const f=await open(join(this.directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o077)||s.uid!==process.getuid?.()||s.size>131072)throw Error('Unsafe journal record');return JSON.parse(await f.readFile('utf8'));}
    finally{await f.close();}
  }
  private async optional(name:string){try{return await this.read(name);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
  private async write(name:string,value:unknown){
    const previous=await this.optional(name);
    if(previous!==undefined){if(!isDeepStrictEqual(previous,value))throw Error('Journal record conflict');return false;}
    const f=await open(join(this.directory,name),'wx',0o600);
    try{await f.writeFile(JSON.stringify(value));await f.sync();}finally{await f.close();}
    const dir=await open(this.directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}
    return true;
  }
  async claim(r:TaskRef){await this.initialize();return this.write(this.key(r)+'.claim',taskRefSchema.parse(r));}
  private async check(r:TaskRef){
    await this.initialize();if(!isDeepStrictEqual(await this.read(this.key(r)+'.claim'),r))throw Error('Journal claim conflict');
  }
  async finish(r:TaskRef,terminal:TaskTerminal){await this.check(r);await this.write(this.key(r)+'.terminal',terminalSchema.parse(terminal));}
  async acknowledge(r:TaskRef){await this.check(r);terminalSchema.parse(await this.read(this.key(r)+'.terminal'));await this.write(this.key(r)+'.ack',{ok:true});}
  async pending():Promise<{ref:TaskRef;terminal?:TaskTerminal}[]>{
    await this.initialize();return this.entries();
  }
  /** Diagnostic snapshot only: never create a directory, write a pin or acknowledge work. */
  async inspect():Promise<{exists:boolean;server?:string;pending:{ref:TaskRef;terminal?:TaskTerminal}[]}>{
    const parent=await lstat(this.root);
    if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)||parent.uid!==process.getuid?.())throw Error('Unsafe journal root');
    let s;try{s=await lstat(this.directory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {exists:false,pending:[]};throw e;}
    if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.())throw Error('Unsafe journal directory');
    const raw=await this.optional('scope.json');
    const scope=raw===undefined?undefined:z.object({server:z.string().min(1).max(2048)}).strict().parse(raw);
    return {exists:true,...scope,pending:await this.entries()};
  }
  private async entries():Promise<{ref:TaskRef;terminal?:TaskTerminal}[]>{
    const files=(await readdir(this.directory)).filter(f=>f!=='scope.json');
    if(files.length>30000||files.some(f=>!/^([a-f0-9]{64})\.(claim|terminal|ack)$/.test(f)))throw Error('Unknown journal record; inspect before resuming');
    const entries:{ref:TaskRef;terminal?:TaskTerminal}[]=[];
    for(const f of files){if(!files.includes(f.replace(/\.[^.]+$/,'.claim')))throw Error('Orphan journal record');}
    for(const name of files.filter(f=>f.endsWith('.claim'))){
      const ref=taskRefSchema.parse(await this.read(name));if(this.key(ref)+'.claim'!==name)throw Error('Journal identity conflict');
      const raw=await this.optional(this.key(ref)+'.terminal');const terminal=raw===undefined?undefined:terminalSchema.parse(raw);
      const ack=await this.optional(this.key(ref)+'.ack');
      if(ack!==undefined){z.object({ok:z.literal(true)}).strict().parse(ack);if(!terminal)throw Error('Journal acknowledgement without result');}
      else entries.push({ref,...(terminal?{terminal}:{})});
    }
    return entries;
  }
}
