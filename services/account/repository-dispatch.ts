import type {offerWork} from './execution-store.ts';
import {canonicalCodeBindings} from './code-repositories.ts';

/** Publication is opt-in at the host boundary. Existing lease reconciliation
 * remains authoritative; only new code eligibility is narrowed. */
export function repositoryBoundOffer(offer:typeof offerWork):typeof offerWork{
  return async(client,context,agentId,profile,bindings=[],artifactStore)=>offer(client,context,agentId,profile,
    profile==='dsh-text'||profile==='codex-code'?await canonicalCodeBindings(client,bindings):[],artifactStore);
}
