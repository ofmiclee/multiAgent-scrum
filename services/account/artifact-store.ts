import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir,rename,rmdir,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {z} from 'zod';
import {
  PORTABLE_ARTIFACT_MAX_BYTES,
  PORTABLE_ARTIFACT_CHUNK_MAX_BYTES,
  storedBytesSchema,
} from '../../packages/domain/code-artifacts.ts';

export const ARTIFACT_CHUNK_MAX_BYTES=PORTABLE_ARTIFACT_CHUNK_MAX_BYTES;

export const artifactScopeSchema=z.object({
  projectId:z.string().uuid(),
  runnerId:z.string().uuid(),
  attemptId:z.string().uuid(),
  fence:z.number().int().positive().max(2_147_483_647),
}).strict();

export type ArtifactScope=z.infer<typeof artifactScopeSchema>;
export type StoredBytes=z.infer<typeof storedBytesSchema>;
export type ArtifactValidator=(bytes:Buffer,reference:StoredBytes)=>void|Promise<void>;
export type StoredArtifact={ref:StoredBytes;bytes:Buffer};
export interface ArtifactStorage {
  begin(scope:ArtifactScope,uploadId:string,reference:StoredBytes,signal:AbortSignal):Promise<void>;
  writeChunk(scope:ArtifactScope,uploadId:string,offset:number,bytes:Buffer,signal:AbortSignal):Promise<void>;
  publish(scope:ArtifactScope,uploadId:string,validate:ArtifactValidator,signal:AbortSignal):Promise<StoredBytes>;
  read(scope:ArtifactScope,uploadId:string,signal:AbortSignal):Promise<StoredArtifact>;
}

type Metadata={schema:1;scope:ArtifactScope;reference:StoredBytes};
type Receipt={schema:1;reference:StoredBytes};
type Chunk={offset:number;hash:string;name:string;bytes:Buffer};

const metadataSchema=z.object({
  schema:z.literal(1),scope:artifactScopeSchema,reference:storedBytesSchema,
}).strict();
const receiptSchema=z.object({schema:z.literal(1),reference:storedBytesSchema}).strict();
const uploadIdSchema=z.string().uuid();
const CHUNK=/^(0|[1-9][0-9]*)\.slot$/;
const TEMP=/^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ArtifactStoreError extends Error {}

function fail(message:string):never{throw new ArtifactStoreError(message);}
function cancelled(signal:AbortSignal){if(signal.aborted)fail('Artifact operation cancelled');}
function sha256(bytes:Buffer){return createHash('sha256').update(bytes).digest('hex');}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
function json(value:unknown){return Buffer.from(JSON.stringify(value));}
function owner(){
  if(typeof process.getuid!=='function')fail('Artifact storage ownership cannot be verified');
  return process.getuid();
}
function missing(error:unknown){return (error as NodeJS.ErrnoException).code==='ENOENT';}

/**
 * A private filesystem byte store. Authentication and portable-domain validation
 * remain caller responsibilities; every operation still requires the exact scope
 * capability which created the upload.
 */
export class ArtifactStore{
  readonly #root:string;

  constructor(root:string){
    if(!isAbsolute(root)||resolve(root)!==root||root==='/')fail('Artifact storage root must be a specific absolute path');
    this.#root=root;
  }

  async begin(scope:ArtifactScope,uploadId:string,reference:StoredBytes,signal:AbortSignal):Promise<void>{
    cancelled(signal);
    const validScope=artifactScopeSchema.parse(scope),id=uploadIdSchema.parse(uploadId),ref=storedBytesSchema.parse(reference);
    await this.#ensureBase(signal);
    const directory=this.#uploadPath(id);
    await mkdir(directory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
    await this.#privateDirectory(directory);
    const metadata:Metadata={schema:1,scope:validScope,reference:ref};
    await this.#install(join(directory,'metadata.slot'),'data.json',json(metadata),signal);
    const stored=await this.#metadata(id,signal);
    if(!same(stored,metadata))fail('Upload identity is already bound to a different capability');
  }

  async writeChunk(scope:ArtifactScope,uploadId:string,offset:number,bytes:Buffer,signal:AbortSignal):Promise<void>{
    cancelled(signal);
    const validScope=artifactScopeSchema.parse(scope),id=uploadIdSchema.parse(uploadId);
    if(!Number.isSafeInteger(offset)||offset<0)fail('Invalid artifact chunk offset');
    if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>ARTIFACT_CHUNK_MAX_BYTES)fail('Artifact chunk size limit exceeded');
    const metadata=await this.#authorized(validScope,id,signal),directory=this.#uploadPath(id);
    if(offset+bytes.length>metadata.reference.sizeBytes)fail('Artifact chunk exceeds declared object size');
    if(offset%ARTIFACT_CHUNK_MAX_BYTES!==0)fail('Artifact chunk offset must be aligned');
    const expected=Math.min(ARTIFACT_CHUNK_MAX_BYTES,metadata.reference.sizeBytes-offset);
    if(bytes.length!==expected)fail('Artifact chunk length does not match its canonical slot');
    if(await this.#exists(join(directory,'published.slot')))fail('Published artifacts are immutable');
    const chunks=await this.#chunks(directory,metadata.reference,signal);
    const existing=chunks.find(chunk=>chunk.offset===offset);
    if(existing){
      if(existing.hash!==sha256(bytes)||!existing.bytes.equals(bytes))fail('Conflicting artifact chunk retry');
      return;
    }
    let next=0;
    for(const chunk of chunks){
      if(chunk.offset!==next)fail('Artifact staging contains a gap');
      next+=chunk.bytes.length;
    }
    if(offset!==next)fail('Artifact chunks must be staged contiguously');
    const target=join(directory,`${offset}.slot`);
    await this.#install(target,'data.chunk',bytes,signal);
  }

  async publish(scope:ArtifactScope,uploadId:string,validate:ArtifactValidator,signal:AbortSignal):Promise<StoredBytes>{
    cancelled(signal);
    if(typeof validate!=='function')fail('Artifact domain validator is required');
    const validScope=artifactScopeSchema.parse(scope),id=uploadIdSchema.parse(uploadId);
    const metadata=await this.#authorized(validScope,id,signal),directory=this.#uploadPath(id);
    const chunks=await this.#chunks(directory,metadata.reference,signal);
    let next=0;
    for(const chunk of chunks){
      if(chunk.offset!==next)fail('Artifact staging is incomplete');
      next+=chunk.bytes.length;
    }
    if(next!==metadata.reference.sizeBytes)fail('Artifact staging is incomplete');
    const bytes=Buffer.concat(chunks.map(chunk=>chunk.bytes),next);
    if(sha256(bytes)!==metadata.reference.sha256)fail('Artifact digest does not match its reference');
    await validate(bytes,metadata.reference);
    cancelled(signal);

    const objectDirectory=join(this.#root,'objects',metadata.reference.sha256.slice(0,2));
    await mkdir(objectDirectory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
    await this.#privateDirectory(objectDirectory);
    const objectPath=this.#objectPath(metadata.reference);
    await this.#install(objectPath,'data.blob',bytes,signal);
    await this.#verifiedBytes(objectPath,metadata.reference,signal);
    const receipt:Receipt={schema:1,reference:metadata.reference};
    await this.#install(join(directory,'published.slot'),'data.json',json(receipt),signal);
    const stored=await this.#receipt(id,signal);
    if(!same(stored,receipt))fail('Published artifact receipt conflicts with upload');
    return metadata.reference;
  }

  async read(scope:ArtifactScope,uploadId:string,signal:AbortSignal):Promise<StoredArtifact>{
    cancelled(signal);
    const validScope=artifactScopeSchema.parse(scope),id=uploadIdSchema.parse(uploadId);
    const metadata=await this.#authorized(validScope,id,signal),receipt=await this.#receipt(id,signal);
    if(!same(receipt.reference,metadata.reference))fail('Published artifact receipt is invalid');
    const bytes=await this.#verifiedBytes(this.#objectPath(metadata.reference),metadata.reference,signal);
    return {ref:metadata.reference,bytes};
  }

  #uploadPath(uploadId:string){return join(this.#root,'uploads',uploadId);}
  #objectPath(reference:StoredBytes){return join(this.#root,'objects',reference.sha256.slice(0,2),`${reference.sha256}.slot`);}

  async #ensureBase(signal:AbortSignal){
    cancelled(signal);
    await this.#noSymlinkAncestors(this.#root);
    await this.#privateDirectory(this.#root);
    for(const name of ['uploads','objects']){
      const directory=join(this.#root,name);
      await mkdir(directory,{mode:0o700}).catch(error=>{if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;});
      await this.#privateDirectory(directory);
    }
  }

  async #noSymlinkAncestors(path:string){
    let current=path;
    for(;;){
      const stat=await lstat(current).catch(error=>missing(error)?fail('Artifact storage path does not exist'):Promise.reject(error));
      if(stat.isSymbolicLink())fail('Artifact storage path contains a symlink');
      const parent=dirname(current);if(parent===current)return;current=parent;
    }
  }

  async #privateDirectory(path:string){
    const stat=await lstat(path).catch(error=>missing(error)?fail('Artifact storage directory does not exist'):Promise.reject(error));
    if(!stat.isDirectory()||stat.isSymbolicLink())fail('Artifact storage directory must not be a symlink');
    if(stat.uid!==owner())fail('Artifact storage directory is not owned by this service');
    if((stat.mode&0o077)!==0||(stat.mode&0o700)!==0o700)fail('Artifact storage directory must be private');
  }

  async #metadata(uploadId:string,signal:AbortSignal):Promise<Metadata>{
    const bytes=await this.#readSlot(join(this.#uploadPath(uploadId),'metadata.slot'),'data.json',16*1024,signal);
    try{return metadataSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{fail('Invalid artifact upload metadata');}
  }

  async #receipt(uploadId:string,signal:AbortSignal):Promise<Receipt>{
    const bytes=await this.#readSlot(join(this.#uploadPath(uploadId),'published.slot'),'data.json',4*1024,signal)
      .catch(error=>{if(missing(error))fail('Artifact has not been published');throw error;});
    try{return receiptSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{fail('Invalid artifact publication receipt');}
  }

  async #authorized(scope:ArtifactScope,uploadId:string,signal:AbortSignal):Promise<Metadata>{
    await this.#ensureBase(signal);
    await this.#privateDirectory(this.#uploadPath(uploadId));
    const metadata=await this.#metadata(uploadId,signal);
    if(!same(metadata.scope,scope))fail('Artifact capability scope does not match upload');
    return metadata;
  }

  async #chunks(directory:string,reference:StoredBytes,signal:AbortSignal):Promise<Chunk[]>{
    cancelled(signal);
    const chunks:Chunk[]=[];
    for(const name of await readdir(directory)){
      cancelled(signal);
      if(name==='metadata.slot'||name==='published.slot')continue;
      if(TEMP.test(name)){
        await this.#privateDirectory(join(directory,name));
        continue;
      }
      const match=CHUNK.exec(name);
      if(!match)fail('Artifact staging contains an unsafe entry');
      const offset=Number(match[1]);
      if(!Number.isSafeInteger(offset)||offset>=reference.sizeBytes)fail('Artifact staging contains an invalid offset');
      const bytes=await this.#readSlot(join(directory,name),'data.chunk',ARTIFACT_CHUNK_MAX_BYTES,signal);
      if(bytes.length<1)fail('Artifact staged chunk is corrupt');
      chunks.push({offset,hash:sha256(bytes),name,bytes});
    }
    chunks.sort((a,b)=>a.offset-b.offset||a.name.localeCompare(b.name));
    for(let i=1;i<chunks.length;i++)if(chunks[i-1].offset===chunks[i].offset)fail('Artifact staging has conflicting chunks');
    return chunks;
  }

  async #verifiedBytes(path:string,reference:StoredBytes,signal:AbortSignal){
    const bytes=await this.#readSlot(path,'data.blob',reference.sizeBytes,signal);
    if(bytes.length!==reference.sizeBytes||sha256(bytes)!==reference.sha256)fail('Stored artifact is corrupt');
    return bytes;
  }

  async #exists(path:string){
    return lstat(path).then(()=>true,error=>missing(error)?false:Promise.reject(error));
  }

  async #assertPrivateFile(path:string,maxBytes:number){
    const stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)fail('Artifact storage entry is not a private regular file');
    if(stat.uid!==owner())fail('Artifact storage entry is not owned by this service');
    if((stat.mode&0o177)!==0)fail('Artifact storage entry must be private and non-executable');
    if(stat.size>maxBytes)fail('Artifact storage entry exceeds its bound');
    return stat;
  }

  async #readPrivate(path:string,maxBytes:number,signal:AbortSignal){
    cancelled(signal);
    const before=await this.#assertPrivateFile(path,maxBytes);
    const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const opened=await handle.stat();
      if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail('Artifact storage entry changed during open');
      const bytes=await handle.readFile({signal});
      cancelled(signal);
      const after=await handle.stat(),current=await lstat(path);
      if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size)fail('Artifact storage entry changed during read');
      return bytes;
    }finally{await handle.close();}
  }

  async #readSlot(slot:string,fileName:string,maxBytes:number,signal:AbortSignal){
    await this.#privateDirectory(slot);
    const entries=await readdir(slot);
    if(entries.length!==1||entries[0]!==fileName)fail('Artifact storage slot is invalid');
    return this.#readPrivate(join(slot,fileName),maxBytes,signal);
  }

  async #install(target:string,fileName:string,bytes:Buffer,signal:AbortSignal){
    cancelled(signal);
    if(await this.#exists(target)){
      const existing=await this.#readSlot(target,fileName,bytes.length,signal);
      if(!existing.equals(bytes))fail('Immutable artifact storage entry conflicts with existing bytes');
      return;
    }
    const parent=dirname(target),temporary=join(parent,`.tmp-${randomUUID()}`);
    await mkdir(temporary,{mode:0o700});await this.#privateDirectory(temporary);
    const temporaryFile=join(temporary,fileName);
    const handle=await open(temporaryFile,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);
    try{await handle.writeFile(bytes,{signal});await handle.sync();await handle.chmod(0o400);cancelled(signal);}
    finally{await handle.close();}
    const directoryHandle=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{await directoryHandle.sync();}finally{await directoryHandle.close();}
    try{await rename(temporary,target);}
    catch(error){
      if(!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
      const existing=await this.#readSlot(target,fileName,bytes.length,signal);
      const matches=existing.equals(bytes);
      await unlink(temporaryFile);await rmdir(temporary);
      if(!matches)fail('Immutable artifact storage entry conflicts with existing bytes');
    }
  }
}
