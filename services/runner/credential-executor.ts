import type {Executor,ExecutionInput} from '../../packages/domain/contracts.ts';

/** A task must name its local credential. Absence is the legacy account only. */
export class CredentialExecutor implements Executor{
  constructor(private readonly connections:ReadonlyMap<string,Executor>){ }
  run(input:ExecutionInput,signal:AbortSignal){
    const account=this.connections.get(input.credentialId??'legacy');
    if(!account)throw Error('Selected local credential is unavailable');
    return account.run(input,signal);
  }
}
