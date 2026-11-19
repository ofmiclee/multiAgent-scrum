import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {Executor,ExecutionInput} from '../domain/contracts.ts';
import {prepareDshTextRuntime,type DshTextOptions} from './dsh-text-profile.ts';
import {DshExecutor} from './dsh.ts';
import {modelIdSchema} from '../domain/agent-models.ts';

/** Product-owned single-request execution; code runs only in the prepared snapshot. */
export class DshTextExecutor implements Executor {
  constructor(private profile:DshTextOptions,private beforePrompt?:()=>Promise<void>) {}
  async run(input:ExecutionInput,signal:AbortSignal) {
    signal.throwIfAborted();
    const prepared=await prepareDshTextRuntime({...this.profile,...(input.model?{model:modelIdSchema.parse(input.model)}:{}),
      ...(input.code?{timeoutMs:600_000}:{} )},input.code?input.cwd:undefined);
    let stopped=false;
    try {
      if(signal.aborted){stopped=true;signal.throwIfAborted();}
      return await new DshExecutor({...prepared.options,beforePrompt:this.beforePrompt}).run({...input,cwd:input.code?input.cwd:join(prepared.root,'work')},signal,()=>{stopped=true;});
    }finally{
      if(stopped)await rm(prepared.root,{recursive:true,force:true});
    }
  }
}
