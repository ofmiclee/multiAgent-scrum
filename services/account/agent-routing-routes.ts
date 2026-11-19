import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {listAgentRouting,saveAgentRouting} from './agent-routing.ts';

const path='/api/account/agent-routing',uuid=z.uuid().transform(value=>value.toLowerCase());
const change=z.object({id:uuid,difficultyMin:z.number().int().min(1).max(5),difficultyMax:z.number().int().min(1).max(5),preference:z.enum(['quality','balanced','economy']),relativeCost:z.number().int().min(1).max(3),expectedVersion:z.number().int().positive()}).strict().refine(value=>value.difficultyMin<=value.difficultyMax);
export function agentRoutingRoute(request:Request){return new URL(request.url).pathname===path&&['GET','POST'].includes(request.method);}
export async function handleAgentRoutingRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  if(request.method==='GET')return listAgentRouting(pool,principal.id);
  const input=z.object({identityId:z.string().min(1).max(128),agents:z.array(change).min(1).max(200)}).strict().refine(value=>new Set(value.agents.map(agent=>agent.id)).size===value.agents.length).parse(await readBoundedJson(request));
  if(input.identityId!==principal.id)throw 403;return saveAgentRouting(pool,principal.id,input.agents);
}
