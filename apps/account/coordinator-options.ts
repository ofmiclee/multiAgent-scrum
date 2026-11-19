type CoordinatorOption={profile:string;enabled:boolean;revoked:boolean;projectGrants:{projectId:string;enabled:boolean}[]};
export function coordinatorCandidates<T extends CoordinatorOption>(agents:T[],projectId:string):T[]{
  return agents.filter(agent=>(agent.profile==='dsh-text'||agent.profile==='codex-code')&&agent.enabled&&!agent.revoked&&agent.projectGrants.some(grant=>grant.projectId===projectId&&grant.enabled));
}
