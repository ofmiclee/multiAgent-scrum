import type {State,Agent} from '../../packages/domain/contracts.ts';

/** Register a device-local resource, never grant it to a project or enable it. */
export function registerDshAgent(s:State,owner:string):Agent {
  if(!s.users.some(u=>u.id===owner)) throw Error('Unknown local Runner owner');
  const id='agent-dsh-'+owner;
  const existing=s.agents.find(a=>a.id===id);
  if(existing) {
    if(existing.ownerId!==owner || existing.provider!=='dsh') throw Error('DSH registration identity conflict');
    existing.capabilities=['writing'];return existing;
  }
  const agent:Agent={id,name:'本机 DSH（仅文本）',ownerId:owner,deviceId:'local-dsh',provider:'dsh',capabilities:['writing'],projectIds:[],maxConcurrency:1,enabled:false,online:false};
  s.agents.push(agent);return agent;
}
