import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {ExecutionInput} from '../../packages/domain/contracts.ts';
import {codeManifestRefSchema,detachedCodeResultSchema,type CodeManifestRef,type DetachedCodeResult} from '../../packages/domain/code-result-artifacts.ts';
import {validateCodeManifestBytes,type CodeBundle} from '../../packages/domain/code-transfer.ts';
import {PORTABLE_ARTIFACT_CHUNK_MAX_BYTES,PORTABLE_ARTIFACT_MAX_BYTES} from '../../packages/domain/code-artifacts.ts';
import {taskRefSchema} from '../../packages/domain/runner-protocol.ts';
import {localDeviceServer,sendDeviceRequest} from './device-client.ts';
import type {DeviceIdentity} from './device-identity.ts';

const refResponse=z.object({ref:codeManifestRefSchema}).strict();
const beginResponse=refResponse.extend({uploadId:z.uuid(),published:z.boolean()}).strict();
const chunkResponse=z.object({nextOffset:z.number().int().positive()}).strict();
const readResponse=refResponse.extend({offset:z.number().int().nonnegative(),bytes:z.string().max(349528),eof:z.boolean()}).strict();
const same=(a:CodeManifestRef,b:CodeManifestRef)=>JSON.stringify(a)===JSON.stringify(b);

/** Only the configured private MAS endpoint receives code. Session authority is
 * supplied by the live task channel; local model credentials never enter it. */
export function createCodeArtifactTransport(options:{server:string;identity:Pick<DeviceIdentity,'runnerId'|'credential'>;session:()=>string|undefined}){
  const server=localDeviceServer(options.server),runnerId=z.uuid().parse(options.identity.runnerId);
  function send(input:ExecutionInput,path:string,body:object,signal:AbortSignal,limit=8192){
    const sessionId=options.session();
    if(!sessionId||!/^[a-f0-9]{64}$/.test(sessionId))throw Error('Authenticated artifact session unavailable');
    const task=taskRefSchema.parse({taskId:input.taskId,attemptId:input.attemptId,fence:input.fence});
    return sendDeviceRequest(server,'/api/runner/code-artifacts/'+path,{runnerId,sessionId,task,...body},options.identity.credential,signal,limit);
  }
  function validate(ref:CodeManifestRef,bytes:Buffer){
    if(bytes.length!==ref.object.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==ref.object.sha256)throw Error('Code artifact integrity mismatch');
    validateCodeManifestBytes(bytes,ref.repositorySnapshotId,ref.changesId,PORTABLE_ARTIFACT_MAX_BYTES);
  }
  return {
    async publish(input:ExecutionInput,artifact:{ref:CodeManifestRef;bytes:Buffer},signal:AbortSignal):Promise<DetachedCodeResult>{
      const ref=codeManifestRefSchema.parse(artifact.ref);validate(ref,artifact.bytes);
      const begun=beginResponse.parse(await send(input,'begin',{ref},signal));
      if(begun.uploadId!==input.attemptId||!same(begun.ref,ref))throw Error('Code artifact publication identity changed');
      if(!begun.published){
        for(let offset=0;offset<artifact.bytes.length;offset+=PORTABLE_ARTIFACT_CHUNK_MAX_BYTES){
          const bytes=artifact.bytes.subarray(offset,offset+PORTABLE_ARTIFACT_CHUNK_MAX_BYTES);
          const reply=chunkResponse.parse(await send(input,'chunk',{uploadId:begun.uploadId,offset,bytes:bytes.toString('base64')},signal));
          if(reply.nextOffset!==offset+bytes.length)throw Error('Code artifact upload offset mismatch');
        }
        const reply=refResponse.parse(await send(input,'commit',{uploadId:begun.uploadId},signal));
        if(!same(reply.ref,ref))throw Error('Code artifact committed reference changed');
      }
      return {uploadId:begun.uploadId,ref};
    },
    async download(input:ExecutionInput,value:DetachedCodeResult,signal:AbortSignal):Promise<CodeBundle>{
      const artifact=detachedCodeResultSchema.parse(value),parts:Buffer[]=[];let offset=0;
      while(offset<artifact.ref.object.sizeBytes){
        const reply=readResponse.parse(await send(input,'read',{artifact,offset},signal,384*1024));
        if(!same(reply.ref,artifact.ref)||reply.offset!==offset)throw Error('Code artifact download reference or offset changed');
        const bytes=Buffer.from(reply.bytes,'base64'),next=offset+bytes.length;
        if(!bytes.length||bytes.length>PORTABLE_ARTIFACT_CHUNK_MAX_BYTES||bytes.toString('base64')!==reply.bytes||next>artifact.ref.object.sizeBytes||reply.eof!==(next===artifact.ref.object.sizeBytes)||(!reply.eof&&bytes.length!==PORTABLE_ARTIFACT_CHUNK_MAX_BYTES))throw Error('Invalid code artifact response chunk');
        parts.push(bytes);offset=next;
      }
      const bytes=Buffer.concat(parts,offset);validate(artifact.ref,bytes);
      return {repositorySnapshotId:artifact.ref.repositorySnapshotId,inputSnapshotId:artifact.ref.inputSnapshotId,changesId:artifact.ref.changesId,manifest:bytes.toString('utf8')};
    },
  };
}
