import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {codeManifestRefSchema,detachedCodeResultSchema,type DetachedCodeResult} from '../../packages/domain/code-result-artifacts.ts';
import {codeInputSchema,validateCodeManifestBytes,type CodeBundle} from '../../packages/domain/code-transfer.ts';
import {taskRefSchema} from '../../packages/domain/runner-protocol.ts';
import {PORTABLE_ARTIFACT_MAX_BYTES,PORTABLE_ARTIFACT_CHUNK_MAX_BYTES} from '../../packages/domain/code-artifacts.ts';
import {readBoundedJson} from '../identity/request.ts';
import {authorizeRunnerSession,runnerCredential,runnerSessionSchema} from './runner-connections.ts';
import {authorizeProject,projectTransaction} from './project-scope.ts';
import type {ArtifactStorage,ArtifactScope} from './artifact-store.ts';
const base=runnerSessionSchema.extend({task:taskRefSchema});
const beginSchema=base.extend({ref:codeManifestRefSchema}).strict();
const uploadSchema=base.extend({uploadId:z.uuid()}).strict();
const chunkSchema=uploadSchema.extend({offset:z.number().int().min(0),bytes:z.string().max(349528)}).strict();
const readSchema=base.extend({artifact:detachedCodeResultSchema,offset:z.number().int().min(0)}).strict();
type Row={attempt_id:string;project_id:string;runner_id:string;fence:number;reference:unknown;published:boolean};
const scope=(r:Row):ArtifactScope=>({projectId:r.project_id,runnerId:r.runner_id,attemptId:r.attempt_id,fence:r.fence});
const same=(a:unknown,b:unknown)=>JSON.stringify(codeManifestRefSchema.parse(a))===JSON.stringify(codeManifestRefSchema.parse(b));
export function codeResultArtifactRoute(request:Request){return request.method==='POST'&&/^\/api\/runner\/code-artifacts\/(begin|chunk|commit|read)$/.test(new URL(request.url).pathname);}

async function active(client:PoolClient,input:z.infer<typeof base>,digest:string){
  const context=await authorizeRunnerSession(client,input,digest);
  const row=(await client.query<{project_id:string;code_context:unknown;agent_id:string}>(`SELECT t.project_id,a.code_context,a.agent_id FROM mas_business_work_attempt a
    JOIN mas_business_work w ON w.id=a.work_id JOIN mas_business_task t ON t.id=w.task_id
    WHERE a.id=$1 AND w.task_id=$2 AND a.fence=$3 AND w.calls=a.fence AND a.runner_id=$4 AND a.owner_id=$5
    AND a.state='running' AND a.lease_until>clock_timestamp() AND w.kind='execute' AND w.state='active' FOR UPDATE OF a`,[input.task.attemptId,input.task.taskId,input.task.fence,input.runnerId,context.user.id])).rows[0];
  if(!row)throw 409;await authorizeProject(client,context.user.identity_id,row.project_id,false);
  const granted=(await client.query(`SELECT 1 FROM mas_business_agent a JOIN mas_business_agent_project g ON g.agent_id=a.id
    WHERE a.id=$1 AND a.runner_id=$2 AND a.owner_id=$3 AND a.profile IN ('dsh-text','codex-code') AND a.enabled AND g.project_id=$4 AND g.enabled FOR SHARE OF a,g`,[row.agent_id,input.runnerId,context.user.id,row.project_id])).rows[0];
  if(!granted)throw 403;
  return {...row,code:codeInputSchema.parse(row.code_context)};
}
async function registered(client:PoolClient,id:string){
  const row=(await client.query<Row>('SELECT * FROM mas_business_code_result_artifact WHERE attempt_id=$1',[id])).rows[0];if(!row)throw 404;return row;
}
/** Reads only registered, validated immutable bytes; caller establishes acceptance/lease authority. */
export async function resolveCodeArtifact(client:PoolClient,store:ArtifactStorage,artifact:DetachedCodeResult,projectId:string):Promise<CodeBundle>{
  const parsed=detachedCodeResultSchema.parse(artifact),row=await registered(client,parsed.uploadId);
  if(!row.published||row.project_id!==projectId||!same(row.reference,parsed.ref))throw 409;
  const {bytes}=await store.read(scope(row),row.attempt_id,new AbortController().signal);
  if(bytes.length!==parsed.ref.object.sizeBytes)throw 409;
  validateCodeManifestBytes(bytes,parsed.ref.repositorySnapshotId,parsed.ref.changesId,PORTABLE_ARTIFACT_MAX_BYTES);
  return {repositorySnapshotId:parsed.ref.repositorySnapshotId,inputSnapshotId:parsed.ref.inputSnapshotId,changesId:parsed.ref.changesId,manifest:bytes.toString('utf8')};
}
export async function assertFinishedCodeArtifact(client:PoolClient,store:ArtifactStorage,artifact:DetachedCodeResult,expected:ArtifactScope){
  const row=await registered(client,artifact.uploadId);
  if(row.attempt_id!==expected.attemptId||row.runner_id!==expected.runnerId||row.project_id!==expected.projectId||row.fence!==expected.fence)throw 409;
  return resolveCodeArtifact(client,store,artifact,expected.projectId);
}

export async function handleCodeResultArtifactRequest(pool:Pool,store:ArtifactStorage,request:Request){
  if(!codeResultArtifactRoute(request))throw 404;
  const path=new URL(request.url).pathname,digest=runnerCredential(request),raw=await readBoundedJson(request,path.endsWith('/chunk')?384*1024:16384),signal=request.signal;
  if(path.endsWith('/begin')){
    const input=beginSchema.parse(raw);
    const row=await projectTransaction(pool,async client=>{
      const access=await active(client,input,digest);if(input.ref.repositorySnapshotId!==access.code.repository.id)throw 400;
      await client.query('SELECT id FROM mas_business_project WHERE id=$1 FOR UPDATE',[access.project_id]);
      const previous=(await client.query<Row>('SELECT * FROM mas_business_code_result_artifact WHERE attempt_id=$1',[input.task.attemptId])).rows[0];
      if(previous){if(!same(previous.reference,input.ref)||previous.runner_id!==input.runnerId||previous.fence!==input.task.fence)throw 409;return previous;}
      const retained=(await client.query<{n:string;bytes:string}>('SELECT count(*) n,coalesce(sum(size_bytes),0) bytes FROM mas_business_code_result_artifact WHERE project_id=$1',[access.project_id])).rows[0];
      if(Number(retained.n)>=64||Number(retained.bytes)+input.ref.object.sizeBytes>192*1024*1024)throw 429;
      return (await client.query<Row>('INSERT INTO mas_business_code_result_artifact(attempt_id,project_id,runner_id,fence,reference,size_bytes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[input.task.attemptId,access.project_id,input.runnerId,input.task.fence,input.ref,input.ref.object.sizeBytes])).rows[0];
    });
    await store.begin(scope(row),row.attempt_id,input.ref.object,signal);return {uploadId:row.attempt_id,ref:input.ref,published:row.published};
  }
  if(path.endsWith('/read')){
    const input=readSchema.parse(raw);
    const ref=await projectTransaction(pool,async client=>{
      const access=await active(client,input,digest);
      if(!access.code.dependencies.some(d=>'uploadId' in d&&d.uploadId===input.artifact.uploadId&&same(d.ref,input.artifact.ref)))throw 403;
      const accepted=(await client.query(`SELECT 1 FROM mas_business_work_attempt a JOIN mas_business_work w ON w.id=a.work_id JOIN mas_business_task t ON t.id=w.task_id
        WHERE a.id=$1 AND a.state='finished' AND a.fence=w.calls AND t.project_id=$2 AND t.status='done' AND w.state='done' AND w.result->'codeArtifact'=$3::jsonb`,[input.artifact.uploadId,access.project_id,JSON.stringify(input.artifact)])).rows[0];
      if(!accepted)throw 403;
      const bundle=await resolveCodeArtifact(client,store,input.artifact,access.project_id);return Buffer.from(bundle.manifest);
    });
    if(input.offset>=ref.length||input.offset%PORTABLE_ARTIFACT_CHUNK_MAX_BYTES!==0)throw 400;
    const bytes=ref.subarray(input.offset,input.offset+PORTABLE_ARTIFACT_CHUNK_MAX_BYTES);
    return {ref:input.artifact.ref,offset:input.offset,bytes:bytes.toString('base64'),eof:input.offset+bytes.length===ref.length};
  }
  const input=path.endsWith('/chunk')?chunkSchema.parse(raw):uploadSchema.parse(raw);
  const row=await projectTransaction(pool,async client=>{
    const access=await active(client,input,digest),row=await registered(client,input.uploadId);
    if(row.attempt_id!==input.task.attemptId||row.runner_id!==input.runnerId||row.fence!==input.task.fence||row.project_id!==access.project_id)throw 409;return row;
  });
  if(path.endsWith('/chunk')){
    const chunk=chunkSchema.parse(raw),bytes=Buffer.from(chunk.bytes,'base64');if(!chunk.bytes||bytes.toString('base64')!==chunk.bytes)throw 400;
    await store.writeChunk(scope(row),row.attempt_id,chunk.offset,bytes,signal);return {nextOffset:chunk.offset+bytes.length};
  }
  const ref=codeManifestRefSchema.parse(row.reference);
  await store.publish(scope(row),row.attempt_id,bytes=>{validateCodeManifestBytes(bytes,ref.repositorySnapshotId,ref.changesId,PORTABLE_ARTIFACT_MAX_BYTES);},signal);
  await projectTransaction(pool,async client=>{await active(client,input,digest);await client.query('UPDATE mas_business_code_result_artifact SET published=true WHERE attempt_id=$1',[row.attempt_id]);});
  return {ref};
}
