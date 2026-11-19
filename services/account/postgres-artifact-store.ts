import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {storedBytesSchema} from '../../packages/domain/code-artifacts.ts';
import {ARTIFACT_CHUNK_MAX_BYTES,ArtifactStoreError,artifactScopeSchema,type ArtifactScope,type ArtifactStorage,type ArtifactValidator,type StoredBytes} from './artifact-store.ts';

type Upload={id:string;scope:ArtifactScope;sha256:string;size_bytes:number;published:boolean};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function fail(message:string):never{throw new ArtifactStoreError(message);}
function check(signal:AbortSignal){if(signal.aborted)fail('Artifact operation cancelled');}
const same=(a:ArtifactScope,b:ArtifactScope)=>a.projectId===b.projectId&&a.runnerId===b.runnerId&&a.attemptId===b.attemptId&&a.fence===b.fence;

/** Durable private PostgreSQL provider. Declared staging bytes reserve capacity;
 * no automatic deletion or duplicate object copy is needed on publication. */
export class PostgresArtifactStore implements ArtifactStorage {
  readonly #pool:Pool;readonly #capacity:number;
  constructor(pool:Pool,capacityBytes=512*1024*1024){
    if(!Number.isSafeInteger(capacityBytes)||capacityBytes<1)fail('Invalid artifact capacity');
    this.#pool=pool;this.#capacity=capacityBytes;
  }
  async #transaction<T>(signal:AbortSignal,run:(client:PoolClient)=>Promise<T>):Promise<T>{
    check(signal);const client=await this.#pool.connect();
    try{await client.query('BEGIN');const result=await run(client);check(signal);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async #upload(client:PoolClient,scope:ArtifactScope,id:string){
    const normalized=artifactScopeSchema.parse(scope);z.uuid().parse(id);
    const row=(await client.query<Upload>('SELECT * FROM mas_artifact_upload WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(!row||!same(artifactScopeSchema.parse(row.scope),normalized))fail('Artifact scope does not match upload');return row;
  }
  async begin(scope:ArtifactScope,id:string,reference:StoredBytes,signal:AbortSignal){
    const valid=artifactScopeSchema.parse(scope),ref=storedBytesSchema.parse(reference);z.uuid().parse(id);
    await this.#transaction(signal,async client=>{
      // Transaction-scoped cross-process serialization makes reservation atomic.
      await client.query("SELECT pg_advisory_xact_lock(184732,20)");
      const existing=(await client.query<Upload>('SELECT * FROM mas_artifact_upload WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(existing){if(!same(existing.scope,valid)||existing.sha256!==ref.sha256||existing.size_bytes!==ref.sizeBytes)fail('Artifact upload conflicts with existing scope or reference');return;}
      const total=(await client.query<{bytes:string}>('SELECT coalesce(sum(size_bytes),0) AS bytes FROM mas_artifact_upload')).rows[0];
      if(Number(total.bytes)+ref.sizeBytes>this.#capacity)fail('Artifact storage capacity exceeded');
      await client.query('INSERT INTO mas_artifact_upload(id,scope,sha256,size_bytes) VALUES($1,$2,$3,$4)',[id,valid,ref.sha256,ref.sizeBytes]);
    });
  }
  async writeChunk(scope:ArtifactScope,id:string,offset:number,bytes:Buffer,signal:AbortSignal){
    if(!Number.isSafeInteger(offset)||offset<0||offset%ARTIFACT_CHUNK_MAX_BYTES!==0||!Buffer.isBuffer(bytes))fail('Invalid artifact chunk');
    await this.#transaction(signal,async client=>{
      const row=await this.#upload(client,scope,id);
      if(row.published)fail('Published artifacts are immutable');
      if(bytes.length<1||bytes.length!==Math.min(ARTIFACT_CHUNK_MAX_BYTES,row.size_bytes-offset))fail('Artifact chunk geometry invalid');
      const prior=(await client.query<{bytes:Buffer}>('SELECT bytes FROM mas_artifact_chunk WHERE upload_id=$1 AND offset_bytes=$2',[id,offset])).rows[0];
      if(prior){if(!prior.bytes.equals(bytes))fail('Artifact chunk retry conflict');return;}
      const total=(await client.query<{size:string}>('SELECT coalesce(sum(octet_length(bytes)),0) AS size FROM mas_artifact_chunk WHERE upload_id=$1',[id])).rows[0];
      if(Number(total.size)!==offset)fail('Artifact chunks must be contiguous');
      await client.query('INSERT INTO mas_artifact_chunk(upload_id,offset_bytes,bytes) VALUES($1,$2,$3)',[id,offset,bytes]);
    });
  }
  async #bytes(client:PoolClient,row:Upload){
    const chunks=(await client.query<{offset_bytes:number;bytes:Buffer}>('SELECT offset_bytes,bytes FROM mas_artifact_chunk WHERE upload_id=$1 ORDER BY offset_bytes',[row.id])).rows;
    let next=0;for(const chunk of chunks){if(chunk.offset_bytes!==next||chunk.bytes.length!==Math.min(ARTIFACT_CHUNK_MAX_BYTES,row.size_bytes-next))fail('Artifact staging incomplete or corrupt');next+=chunk.bytes.length;}
    if(next!==row.size_bytes)fail('Artifact staging incomplete');
    const bytes=Buffer.concat(chunks.map(c=>c.bytes),next);if(digest(bytes)!==row.sha256)fail('Artifact digest mismatch');return bytes;
  }
  async publish(scope:ArtifactScope,id:string,validate:ArtifactValidator,signal:AbortSignal){
    if(typeof validate!=='function')fail('Artifact domain validator required');
    return this.#transaction(signal,async client=>{
      const row=await this.#upload(client,scope,id),bytes=await this.#bytes(client,row),ref=storedBytesSchema.parse({sha256:row.sha256,sizeBytes:row.size_bytes});
      await validate(bytes,ref);check(signal);
      await client.query('UPDATE mas_artifact_upload SET published=true WHERE id=$1',[id]);return ref;
    });
  }
  async read(scope:ArtifactScope,id:string,signal:AbortSignal){
    return this.#transaction(signal,async client=>{
      const row=await this.#upload(client,scope,id);if(!row.published)fail('Artifact has not been published');
      return {ref:storedBytesSchema.parse({sha256:row.sha256,sizeBytes:row.size_bytes}),bytes:await this.#bytes(client,row)};
    });
  }
}
