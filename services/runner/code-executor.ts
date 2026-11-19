import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {ExecutionInput,ExecutionResult,Executor} from '../../packages/domain/contracts.ts';
import {codeBindingSchema,codeInputSchema,validateCodeComposition,type CodeBinding,type CodeBundle} from '../../packages/domain/code-transfer.ts';
import {PORTABLE_ARTIFACT_MAX_BYTES} from '../../packages/domain/code-artifacts.ts';
import type {CodeManifestRef,DetachedCodeResult} from '../../packages/domain/code-result-artifacts.ts';
import {SnapshotStore} from './snapshots.ts';
import {ExecutorStopUnconfirmed} from '../../packages/domain/execution-errors.ts';

/** Formal code adapter. The native report is descriptive only; transferable
 * code is always rebuilt from the settled isolated filesystem. */
export class CodeWorkspaceExecutor implements Executor {
  private bindings=new Map<string,CodeBinding>();
  private open=true;
  constructor(private options:{executor:Executor;snapshots:SnapshotStore;bindings:CodeBinding[];artifacts?:{
    download(input:ExecutionInput,artifact:DetachedCodeResult,signal:AbortSignal):Promise<CodeBundle>;
    publish(input:ExecutionInput,artifact:{ref:CodeManifestRef;bytes:Buffer},signal:AbortSignal):Promise<DetachedCodeResult>;
  }}){
    if(options.bindings.length>10)throw Error('Too many local code bindings');
    for(const raw of options.bindings){
      const binding=codeBindingSchema.parse(raw);
      if(this.bindings.has(binding.projectId))throw Error('Duplicate local code binding');
      this.bindings.set(binding.projectId,binding);
    }
  }
  accepting(){return this.open;}
  async run(input:ExecutionInput,signal:AbortSignal):Promise<ExecutionResult>{
    if(!this.open)throw Error('Agent runtime is not accepting new work');
    if(input.purpose==='assess'||input.purpose==='decompose'||!input.code){
      if(input.code)throw Error('Assessment cannot contain code input');
      const cwd=await mkdtemp(join(tmpdir(),'mas-agent-text-'));
      let settled=true;
      try{
        const result=await this.options.executor.run({...input,cwd},signal);
        if(!result.nativeSession||result.code||result.codeArtifact)throw Error('Assessment requires native text output only');
        return {summary:result.summary,artifacts:[],checksPassed:false,nativeSession:result.nativeSession};
      }catch(error){
        // A settled text attempt can be retried after the server's recovery
        // checks. Only an unconfirmed process stop quarantines this executor.
        if(error instanceof ExecutorStopUnconfirmed){this.open=false;settled=false;}
        throw error;
      }
      finally{if(settled)await rm(cwd,{recursive:true,force:true});}
    }
    const code=codeInputSchema.parse(input.code);
    const binding=this.bindings.get(code.projectId);
    if(!binding||!isDeepStrictEqual(binding.repository,code.repository))throw Error('Code input does not match the local repository binding');
    const resolved:CodeBundle[]=[];
    for(const dependency of code.dependencies){
      if('uploadId' in dependency){
        if(!this.options.artifacts)throw Error('Detached code transport unavailable');
        resolved.push(await this.options.artifacts.download(input,dependency,signal));
      }else resolved.push(dependency);
    }
    for(const dependency of resolved)if(dependency.repositorySnapshotId!==binding.repository.id)throw Error('Foreign repository code dependency');
    validateCodeComposition(resolved,PORTABLE_ARTIFACT_MAX_BYTES);
    const changes=[];
    for(let index=0;index<resolved.length;index++){
      const dependency=code.dependencies[index],bundle=resolved[index];
      changes.push('uploadId' in dependency?await this.options.snapshots.importCodeArtifact(dependency.ref,Buffer.from(bundle.manifest),signal):await this.options.snapshots.importCode(bundle,signal));
    }
    const prepared=await this.options.snapshots.prepare(binding.repository,changes,`attempt-${randomUUID()}`,signal);
    let invoked=false;
    try{
      invoked=true;
      const native=await this.options.executor.run({...input,code,cwd:prepared.cwd},signal);
      if(!native.nativeSession)throw Error('Native Agent execution identity is required');
      const collected=await this.options.snapshots.collect(prepared,signal);
      const artifact=await this.options.snapshots.exportCodeArtifact(collected.changes,prepared.inputSnapshotId,signal);
      if(artifact.bytes.length>32768){
        if(!this.options.artifacts)throw Error('Large code result requires durable artifact transport');
        const codeArtifact=await this.options.artifacts.publish(input,artifact,signal);
        return {summary:native.summary,artifacts:collected.artifacts,checksPassed:false,nativeSession:native.nativeSession,codeArtifact};
      }
      const bundle=await this.options.snapshots.exportCode(collected.changes,prepared.inputSnapshotId,signal);
      return {summary:native.summary,artifacts:collected.artifacts,checksPassed:false,nativeSession:native.nativeSession,code:bundle};
    }catch(error){
      if(invoked)this.open=false;
      throw error;
    }
  }
}

/** Preserve the existing import name for callers outside the Runner factory. */
export {CodeWorkspaceExecutor as CodexCodeExecutor};
