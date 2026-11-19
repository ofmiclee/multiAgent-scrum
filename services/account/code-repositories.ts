import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {PORTABLE_ARTIFACT_CHUNK_MAX_BYTES,repositoryArchiveRefSchema,validateRepositoryArchiveBytes,type RepositoryArchiveRef} from '../../packages/domain/code-artifacts.ts';
import type {CodeBinding} from '../../packages/domain/code-transfer.ts';
import {readBoundedJson} from '../identity/request.ts';
import {type ArtifactStorage,type ArtifactScope} from './artifact-store.ts';
import {projectTransaction} from './project-scope.ts';
import {authorizeRunnerSession,runnerCredential,runnerSessionSchema} from './runner-connections.ts';

const uuid=z.uuid().transform(value=>value.toLowerCase());
const base=runnerSessionSchema;
const beginSchema=base.extend({projectId:uuid,requestId:uuid,ref:repositoryArchiveRefSchema}).strict();
const uploadSchema=base.extend({uploadId:uuid}).strict();
const chunkSchema=uploadSchema.extend({offset:z.number().int().min(0),bytes:z.string().max(Math.ceil(PORTABLE_ARTIFACT_CHUNK_MAX_BYTES/3)*4)}).strict();
const infoSchema=base.extend({projectId:uuid}).strict();
const readSchema=infoSchema.extend({offset:z.number().int().min(0)}).strict();
const paths=new Set(['/api/runner/repositories/begin','/api/runner/repositories/chunk','/api/runner/repositories/commit','/api/runner/repositories/abort','/api/runner/repositories/info','/api/runner/repositories/read']);
const MAX_PENDING_UPLOADS_PER_RUNNER_PROJECT=4;
const MAX_RETAINED_UPLOADS_PER_RUNNER_PROJECT=64;
const MAX_RETAINED_BYTES_PER_RUNNER_PROJECT=192*1024*1024;

type UploadRow={id:string;request_id:string;project_id:string;runner_id:string;owner_id:string;reference:unknown;state:'staging'|'published'|'abandoned'};
type PublishedRow={project_id:string;publication_id:string;published_by_runner:string;published_by_user:string;reference:unknown};

export function repositoryRoute(request:Request){return request.method==='POST'&&paths.has(new URL(request.url).pathname);}

/** Keep dispatch eligible only for the exact immutable base published for a project. */
export async function canonicalCodeBindings(client:PoolClient,bindings:CodeBinding[]):Promise<CodeBinding[]>{
  if(!bindings.length)return [];
  const ids=[...new Set(bindings.map(binding=>binding.projectId))];
  const rows=await client.query<{project_id:string;reference:unknown}>('SELECT project_id,reference FROM mas_business_code_repository WHERE project_id=ANY($1::uuid[])',[ids]);
  const canonical=new Map(rows.rows.map(row=>[row.project_id,exactRef(row.reference).repository]));
  return bindings.filter(binding=>{
    const repository=canonical.get(binding.projectId);
    return !!repository&&repository.id===binding.repository.id&&repository.commit===binding.repository.commit&&
      repository.fileCount===binding.repository.fileCount&&repository.createdAt===binding.repository.createdAt;
  });
}

function exactRef(value:unknown){return repositoryArchiveRefSchema.parse(value);}
function sameRef(left:unknown,right:unknown){return JSON.stringify(exactRef(left))===JSON.stringify(exactRef(right));}
function scope(upload:UploadRow):ArtifactScope{return {projectId:upload.project_id,runnerId:upload.runner_id,attemptId:upload.id,fence:1};}
function strictBase64(value:string){
  const bytes=Buffer.from(value,'base64');
  if(!value||bytes.toString('base64')!==value)throw 400;
  if(bytes.length>PORTABLE_ARTIFACT_CHUNK_MAX_BYTES)throw 413;
  return bytes;
}

async function projectAccess(client:PoolClient,userId:string,projectId:string,admin:boolean){
  const project=(await client.query<{organization_id:string}>('SELECT organization_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0];
  if(!project)throw 404;
  const organization=(await client.query<{status:string}>('SELECT status FROM mas_business_membership WHERE organization_id=$1 AND user_id=$2 FOR SHARE',[project.organization_id,userId])).rows[0];
  if(!organization)throw 404;if(organization.status!=='active')throw 403;
  const member=(await client.query<{role:string;status:string}>('SELECT role,status FROM mas_business_project_member WHERE project_id=$1 AND user_id=$2 FOR SHARE',[projectId,userId])).rows[0];
  if(!member)throw 404;if(member.status!=='active'||member.role==='viewer'||(admin&&member.role!=='owner'))throw 403;
}

async function authorize(client:PoolClient,input:z.infer<typeof base>,digest:string){
  return authorizeRunnerSession(client,input,digest);
}

async function uploadForRunner(client:PoolClient,uploadId:string,runnerId:string,userId:string){
  const upload=(await client.query<UploadRow>('SELECT * FROM mas_business_code_repository_upload WHERE id=$1 FOR UPDATE',[uploadId])).rows[0];
  if(!upload||upload.runner_id!==runnerId||upload.owner_id!==userId)throw 404;
  return upload;
}

async function begin(pool:Pool,store:ArtifactStorage,input:z.infer<typeof beginSchema>,digest:string,signal:AbortSignal){
  const result=await projectTransaction(pool,async client=>{
    const {user}=await authorize(client,input,digest);await projectAccess(client,user.id,input.projectId,true);
    await client.query('SELECT id FROM mas_business_project WHERE id=$1 FOR UPDATE',[input.projectId]);
    const canonical=(await client.query<PublishedRow>('SELECT * FROM mas_business_code_repository WHERE project_id=$1 FOR SHARE',[input.projectId])).rows[0];
    if(canonical){if(!sameRef(canonical.reference,input.ref))throw 409;return {uploadId:canonical.publication_id,published:true,ref:exactRef(canonical.reference),upload:null};}
    const previous=(await client.query<UploadRow>('SELECT * FROM mas_business_code_repository_upload WHERE runner_id=$1 AND request_id=$2 FOR UPDATE',[input.runnerId,input.requestId])).rows[0];
    if(previous){
      if(previous.project_id!==input.projectId||previous.owner_id!==user.id||!sameRef(previous.reference,input.ref))throw 409;
      if(previous.state==='abandoned')throw 409;
      return {uploadId:previous.id,published:previous.state==='published',ref:exactRef(previous.reference),upload:previous};
    }
    const retained=(await client.query<{active:string;rows:string;bytes:string}>(`SELECT
      count(*) FILTER (WHERE state='staging') AS active,
      count(*) AS rows,
      coalesce(sum(size_bytes),0) AS bytes
      FROM mas_business_code_repository_upload WHERE project_id=$1 AND runner_id=$2`,[input.projectId,input.runnerId])).rows[0];
    if(Number(retained.active)>=MAX_PENDING_UPLOADS_PER_RUNNER_PROJECT||
      Number(retained.rows)>=MAX_RETAINED_UPLOADS_PER_RUNNER_PROJECT||
      Number(retained.bytes)+input.ref.object.sizeBytes>MAX_RETAINED_BYTES_PER_RUNNER_PROJECT)throw 429;
    const id=randomUUID();
    const upload=(await client.query<UploadRow>(`INSERT INTO mas_business_code_repository_upload
      (id,request_id,project_id,runner_id,owner_id,reference,object_sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[id,input.requestId,input.projectId,input.runnerId,user.id,input.ref,input.ref.object.sha256,input.ref.object.sizeBytes])).rows[0];
    return {uploadId:id,published:false,ref:input.ref,upload};
  });
  if(result.upload)await store.begin(scope(result.upload),result.upload.id,result.ref.object,signal);
  return {uploadId:result.uploadId,published:result.published,ref:result.ref};
}

async function staged(pool:Pool,input:z.infer<typeof uploadSchema>,digest:string){
  return projectTransaction(pool,async client=>{
    const {user}=await authorize(client,input,digest),upload=await uploadForRunner(client,input.uploadId,input.runnerId,user.id);
    await projectAccess(client,user.id,upload.project_id,true);return upload;
  });
}

async function abandon(pool:Pool,input:z.infer<typeof uploadSchema>,digest:string){
  await projectTransaction(pool,async client=>{
    const {user}=await authorize(client,input,digest),upload=await uploadForRunner(client,input.uploadId,input.runnerId,user.id);
    await projectAccess(client,user.id,upload.project_id,true);
    if(upload.state==='published')throw 409;
    if(upload.state==='staging')await client.query("UPDATE mas_business_code_repository_upload SET state='abandoned',abandoned_at=clock_timestamp() WHERE id=$1",[upload.id]);
  });
  return {ok:true as const};
}

async function chunk(pool:Pool,store:ArtifactStorage,input:z.infer<typeof chunkSchema>,digest:string,signal:AbortSignal){
  const bytes=strictBase64(input.bytes),upload=await staged(pool,input,digest);
  if(upload.state!=='staging')throw 409;
  const ref=exactRef(upload.reference),expected=Math.min(PORTABLE_ARTIFACT_CHUNK_MAX_BYTES,ref.object.sizeBytes-input.offset);
  if(input.offset%PORTABLE_ARTIFACT_CHUNK_MAX_BYTES!==0||expected<1||bytes.length!==expected)throw 400;
  await store.writeChunk(scope(upload),upload.id,input.offset,bytes,signal);
  return {nextOffset:input.offset+bytes.length};
}

async function commit(pool:Pool,store:ArtifactStorage,input:z.infer<typeof uploadSchema>,digest:string,signal:AbortSignal){
  let upload=await staged(pool,input,digest),invalid=false;
  if(upload.state==='abandoned')throw 409;
  try{
    await store.publish(scope(upload),upload.id,bytes=>{
      try{validateRepositoryArchiveBytes(exactRef(upload.reference),bytes);}catch(error){invalid=true;throw error;}
    },signal);
  }catch(error){if(invalid){await abandon(pool,input,digest);throw 400;}throw error;}
  return projectTransaction(pool,async client=>{
    const {user}=await authorize(client,input,digest);upload=await uploadForRunner(client,input.uploadId,input.runnerId,user.id);
    await projectAccess(client,user.id,upload.project_id,true);
    if(upload.state==='abandoned')throw 409;
    await client.query('SELECT id FROM mas_business_project WHERE id=$1 FOR UPDATE',[upload.project_id]);
    const ref=exactRef(upload.reference);
    const canonical=(await client.query<PublishedRow>('SELECT * FROM mas_business_code_repository WHERE project_id=$1',[upload.project_id])).rows[0];
    if(canonical&&!sameRef(canonical.reference,ref))throw 409;
    if(!canonical)await client.query(`INSERT INTO mas_business_code_repository
      (project_id,publication_id,published_by_runner,published_by_user,reference,object_sha256,size_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[upload.project_id,upload.id,upload.runner_id,upload.owner_id,ref,ref.object.sha256,ref.object.sizeBytes]);
    await client.query("UPDATE mas_business_code_repository_upload SET state='published',committed_at=coalesce(committed_at,clock_timestamp()) WHERE id=$1",[upload.id]);
    return {ref:canonical?exactRef(canonical.reference):ref};
  });
}

async function downloadable(client:PoolClient,input:z.infer<typeof infoSchema>,digest:string){
  const {user,device}=await authorize(client,input,digest);await projectAccess(client,user.id,input.projectId,false);
  const allowed=(await client.query(`SELECT 1 FROM mas_business_agent a JOIN mas_business_agent_project g
    ON g.agent_id=a.id AND g.owner_id=a.owner_id WHERE a.runner_id=$1 AND a.owner_id=$2 AND a.profile IN ('dsh-text','codex-code')
    AND a.enabled AND g.project_id=$3 AND g.enabled LIMIT 1`,[device.id,user.id,input.projectId])).rows[0];
  if(!allowed)throw 403;
  const repository=(await client.query<PublishedRow>('SELECT * FROM mas_business_code_repository WHERE project_id=$1',[input.projectId])).rows[0];
  if(!repository)throw 404;return repository;
}

async function info(pool:Pool,input:z.infer<typeof infoSchema>,digest:string){
  const repository=await projectTransaction(pool,client=>downloadable(client,input,digest));
  return {ref:exactRef(repository.reference)};
}

async function read(pool:Pool,store:ArtifactStorage,input:z.infer<typeof readSchema>,digest:string,signal:AbortSignal){
  const repository=await projectTransaction(pool,client=>downloadable(client,input,digest)),ref=exactRef(repository.reference);
  if(input.offset>=ref.object.sizeBytes)throw 400;
  const artifact=await store.read({projectId:repository.project_id,runnerId:repository.published_by_runner,attemptId:repository.publication_id,fence:1},repository.publication_id,signal);
  const bytes=artifact.bytes.subarray(input.offset,Math.min(input.offset+PORTABLE_ARTIFACT_CHUNK_MAX_BYTES,artifact.bytes.length));
  return {ref,offset:input.offset,bytes:bytes.toString('base64'),eof:input.offset+bytes.length===artifact.bytes.length};
}

/** Route-only handler. The account service remains responsible for selecting it. */
export async function handleRepositoryRequest(pool:Pool,store:ArtifactStorage,request:Request):Promise<unknown>{
  if(!repositoryRoute(request))throw 404;
  const digest=runnerCredential(request),path=new URL(request.url).pathname,signal=request.signal;
  const raw=await readBoundedJson(request,path.endsWith('/chunk')?384*1024:16_384);
  if(path.endsWith('/begin'))return begin(pool,store,beginSchema.parse(raw),digest,signal);
  if(path.endsWith('/chunk'))return chunk(pool,store,chunkSchema.parse(raw),digest,signal);
  if(path.endsWith('/commit'))return commit(pool,store,uploadSchema.parse(raw),digest,signal);
  if(path.endsWith('/abort'))return abandon(pool,uploadSchema.parse(raw),digest);
  if(path.endsWith('/info'))return info(pool,infoSchema.parse(raw),digest);
  if(path.endsWith('/read'))return read(pool,store,readSchema.parse(raw),digest,signal);
  throw 404;
}
