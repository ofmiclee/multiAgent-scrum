import {createHash} from 'node:crypto';
import {z} from 'zod';
import {PORTABLE_ARTIFACT_CHUNK_MAX_BYTES,repositoryArchiveRefSchema,type RepositoryArchiveRef} from '../../packages/domain/code-artifacts.ts';
import type {RepositorySnapshot} from '../../packages/domain/contracts.ts';
import type {CodeBinding} from '../../packages/domain/code-transfer.ts';
import {isDeepStrictEqual} from 'node:util';
import {DeviceResponseError,localDeviceServer,sendDeviceRequest} from './device-client.ts';
import type {DeviceIdentity} from './device-identity.ts';
import {SnapshotStore} from './snapshots.ts';

export {DeviceResponseError as RepositoryTransportError};

type Identity=Pick<DeviceIdentity,'runnerId'|'credential'>;
type RepositorySession={server:string;identity:Identity;sessionId:string;signal:AbortSignal};
type Common=RepositorySession&{projectId:string;snapshots:SnapshotStore;expected?:RepositorySnapshot};
type PublishOptions=Common&{snapshot:RepositorySnapshot;requestId:string};

const uuid=z.uuid().transform(value=>value.toLowerCase());
const beginResponse=z.object({uploadId:uuid,published:z.boolean(),ref:repositoryArchiveRefSchema}).strict();
const chunkResponse=z.object({nextOffset:z.number().int().positive()}).strict();
const refResponse=z.object({ref:repositoryArchiveRefSchema}).strict();
const readResponse=refResponse.extend({offset:z.number().int().min(0),bytes:z.string().max(Math.ceil(PORTABLE_ARTIFACT_CHUNK_MAX_BYTES/3)*4),eof:z.boolean()}).strict();

function session(options:RepositorySession){
  return {runnerId:uuid.parse(options.identity.runnerId),sessionId:z.string().regex(/^[a-f0-9]{64}$/).parse(options.sessionId)};
}
function same(left:RepositoryArchiveRef,right:RepositoryArchiveRef){return JSON.stringify(left)===JSON.stringify(right);}
function check(signal:AbortSignal){if(signal.aborted)throw Error('Repository transport cancelled');}
function decode(value:string){
  const bytes=Buffer.from(value,'base64');
  if(!value||bytes.length>PORTABLE_ARTIFACT_CHUNK_MAX_BYTES||bytes.toString('base64')!==value)throw Error('Repository response chunk exceeds limit or is invalid');
  return bytes;
}
async function send(options:RepositorySession,path:string,body:object,limit=8192){
  check(options.signal);
  return sendDeviceRequest(options.server,'/api/runner/repositories/'+path,{...session(options),...body},options.identity.credential,options.signal,limit);
}

/** A live authenticated capability distinguishes disabled storage from missing
 * repositories. Unknown/older responses and authorization errors never opt out. */
export async function codeArtifactCapability(options:RepositorySession):Promise<'disabled'|'private-v1'>{
  check(options.signal);const server=localDeviceServer(options.server);
  const response=await sendDeviceRequest(server,'/api/runner/capabilities',session(options),options.identity.credential,options.signal);
  return z.object({codeArtifacts:z.enum(['disabled','private-v1'])}).strict().parse(response).codeArtifacts;
}

/** Explicitly abandon an incomplete upload. Transport failures never call this automatically. */
export async function abortCodeRepositoryUpload(options:RepositorySession,uploadId:string):Promise<{ok:true}>{
  check(options.signal);const normalized={...options,server:localDeviceServer(options.server)};
  return z.object({ok:z.literal(true)}).strict().parse(await send(normalized,'abort',{uploadId:uuid.parse(uploadId)}));
}

/** Export and explicitly publish one immutable canonical project base. */
export async function publishCodeRepository(options:PublishOptions):Promise<RepositoryArchiveRef>{
  uuid.parse(options.requestId);check(options.signal);const normalized={...options,server:localDeviceServer(options.server)};
  const artifact=await normalized.snapshots.exportRepository(normalized.snapshot,normalized.signal);
  const begun=beginResponse.parse(await send(normalized,'begin',{projectId:uuid.parse(normalized.projectId),requestId:normalized.requestId,ref:artifact.ref}));
  if(!same(begun.ref,artifact.ref))throw Error('Repository publication reference changed');
  if(!begun.published){
    for(let offset=0;offset<artifact.bytes.length;offset+=PORTABLE_ARTIFACT_CHUNK_MAX_BYTES){
      check(normalized.signal);
      const bytes=artifact.bytes.subarray(offset,offset+PORTABLE_ARTIFACT_CHUNK_MAX_BYTES);
      const reply=chunkResponse.parse(await send(normalized,'chunk',{uploadId:begun.uploadId,offset,bytes:bytes.toString('base64')}));
      if(reply.nextOffset!==offset+bytes.length)throw Error('Repository upload offset mismatch');
    }
    const committed=refResponse.parse(await send(normalized,'commit',{uploadId:begun.uploadId}));
    if(!same(committed.ref,artifact.ref))throw Error('Repository committed reference changed');
  }
  return artifact.ref;
}

/** Download bounded chunks and import only after complete portable validation. */
export async function downloadCodeRepository(options:Common):Promise<RepositorySnapshot>{
  check(options.signal);const normalized={...options,server:localDeviceServer(options.server)};
  const {ref}=refResponse.parse(await send(normalized,'info',{projectId:uuid.parse(normalized.projectId)}));
  if(normalized.expected&&!isDeepStrictEqual(ref.repository,normalized.expected))throw Error('Published repository does not match the immutable local binding');
  const parts:Buffer[]=[];let offset=0;
  while(offset<ref.object.sizeBytes){
    check(normalized.signal);
    const reply=readResponse.parse(await send(normalized,'read',{projectId:uuid.parse(normalized.projectId),offset},384*1024));
    if(!same(reply.ref,ref)||reply.offset!==offset)throw Error('Repository download reference or offset changed');
    const bytes=decode(reply.bytes);
    if(offset+bytes.length>ref.object.sizeBytes||reply.eof!==(offset+bytes.length===ref.object.sizeBytes))throw Error('Repository download length mismatch');
    parts.push(bytes);offset+=bytes.length;
  }
  const bytes=Buffer.concat(parts,offset);
  if(bytes.length!==ref.object.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==ref.object.sha256)throw Error('Repository download integrity mismatch');
  return normalized.snapshots.importRepository(ref,bytes,normalized.signal);
}

/** A configured binding is the only source of project code admission. Download
 * its canonical base, or let its authorized project owner publish that base.
 * A deterministic request identity resumes partial publication after restart. */
export async function prepareCodeRepositories(options:RepositorySession&{snapshots:SnapshotStore;bindings:CodeBinding[]}):Promise<void>{
  const server=localDeviceServer(options.server);
  for(const binding of options.bindings){
    const common={...options,server,projectId:binding.projectId,expected:binding.repository};
    try{await downloadCodeRepository(common);}
    catch(error){
      if(!(error instanceof DeviceResponseError)||error.status!==404)throw error;
      const hash=createHash('sha256').update(JSON.stringify(['mas-repository-publication-v1',options.identity.runnerId,binding.projectId,binding.repository])).digest('hex');
      const requestId=`${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
      await publishCodeRepository({...common,snapshot:binding.repository,requestId});
    }
  }
}
