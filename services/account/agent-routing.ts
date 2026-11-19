import type {Pool,PoolClient} from 'pg';
import {authorizeProject,projectTransaction} from './project-scope.ts';

export type RoutingPreference='quality'|'balanced'|'economy';
export type RoutingCandidate={id:string;authorized:boolean;online:boolean;capacityAvailable:boolean;capabilities:string[];difficultyMin:number;difficultyMax:number;preference:RoutingPreference;relativeCost:number;accepted:number;rejected:number};
export type RoutingTask={requiredCapabilities:string[];difficulty:number};

export function rankEligibleAgents(task:RoutingTask,candidates:RoutingCandidate[]){
  return candidates.flatMap(candidate=>{
    const filters={authorized:candidate.authorized,online:candidate.online,capacityAvailable:candidate.capacityAvailable,
      difficulty:task.difficulty>=candidate.difficultyMin&&task.difficulty<=candidate.difficultyMax};
    if(Object.values(filters).some(value=>!value))return [];
    const sampleSize=candidate.accepted+candidate.rejected;
    // Beta(2,2) prior prevents one lucky result from dominating established evidence.
    const acceptance=(candidate.accepted+2)/(sampleSize+4);
    const costScore=(4-candidate.relativeCost)/3;
    const weights=candidate.preference==='quality'?[0.8,0.2]:candidate.preference==='economy'?[0.35,0.65]:[0.6,0.4];
    const score=acceptance*weights[0]+costScore*weights[1];
    return [{id:candidate.id,score,audit:{filters,preference:candidate.preference,relativeCost:candidate.relativeCost,weights:{quality:weights[0],cost:weights[1]},history:{accepted:candidate.accepted,rejected:candidate.rejected,sampleSize,conservativeAcceptance:acceptance},
      explanation:`最近 ${sampleSize} 次已结束且经人工验收的结果；质量权重 ${weights[0]}，相对资源成本权重 ${weights[1]}。`}}];
  }).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
}

export async function routingHistory(client:PoolClient,agentIds:string[]){
  if(!agentIds.length)return new Map<string,{accepted:number;rejected:number}>();
  const rows=await client.query<{agentId:string;accepted:number;rejected:number}>(`SELECT "agentId",
    count(*) FILTER(WHERE decision='accept')::int AS accepted,count(*) FILTER(WHERE decision='reject')::int AS rejected
    FROM (SELECT a.agent_id AS "agentId",r.decision,row_number() OVER(PARTITION BY a.agent_id ORDER BY r.created_at DESC,r.attempt_id DESC) AS position
      FROM mas_business_work_attempt a JOIN mas_business_work_review r ON r.attempt_id=a.id
      WHERE a.agent_id=ANY($1::uuid[]) AND a.state='finished' AND a.finished_at IS NOT NULL) reviewed
    WHERE position<=100 GROUP BY "agentId"`,[agentIds]);
  return new Map(rows.rows.map(row=>[row.agentId,{accepted:row.accepted,rejected:row.rejected}]));
}

export async function listAgentRouting(pool:Pool,identityId:string,projectId?:string){
  return projectTransaction(pool,async client=>{
    if(projectId)await authorizeProject(client,identityId,projectId,false);
    const user=(await client.query<{id:string;status:string}>('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR SHARE',[identityId])).rows[0];
    if(!user)return {identityId,agents:[]};if(user.status!=='active')throw 403;
    const result=await client.query<{id:string;difficultyMin:number;difficultyMax:number;preference:RoutingPreference;relativeCost:number;version:number;lastDecision:unknown}>(`SELECT a.id,a.difficulty_min AS "difficultyMin",a.difficulty_max AS "difficultyMax",a.routing_preference AS preference,a.relative_cost AS "relativeCost",a.routing_version AS version,
      (SELECT jsonb_build_object('score',d.score,'explanation',d.explanation,'createdAt',d.created_at) FROM mas_business_routing_decision d WHERE d.agent_id=a.id ORDER BY d.created_at DESC LIMIT 1) AS "lastDecision"
      FROM mas_business_agent a WHERE a.owner_id=$1 AND a.deleted_at IS NULL ORDER BY a.created_at,a.id`,[user.id]);
    const history=await routingHistory(client,result.rows.map(row=>row.id));
    return {identityId,agents:result.rows.map(agent=>({...agent,history:history.get(agent.id)??{accepted:0,rejected:0}}))};
  });
}

export async function saveAgentRouting(pool:Pool,identityId:string,changes:{id:string;difficultyMin:number;difficultyMax:number;preference:RoutingPreference;relativeCost:number;expectedVersion:number}[]){
  return projectTransaction(pool,async client=>{
    const user=(await client.query<{id:string;status:string}>('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR UPDATE',[identityId])).rows[0];
    if(!user)throw 404;if(user.status!=='active')throw 403;
    for(const change of [...changes].sort((a,b)=>a.id.localeCompare(b.id))){
      const current=(await client.query<{routing_version:number}>('SELECT routing_version FROM mas_business_agent WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',[change.id,user.id])).rows[0];
      if(!current)throw 404;if(current.routing_version!==change.expectedVersion)throw 409;
      await client.query(`UPDATE mas_business_agent SET routing_capabilities=NULL,difficulty_min=$3,difficulty_max=$4,routing_preference=$5,relative_cost=$6,routing_version=routing_version+1
        WHERE id=$1 AND owner_id=$2`,[change.id,user.id,change.difficultyMin,change.difficultyMax,change.preference,change.relativeCost]);
    }
    return {identityId,saved:true};
  });
}

/** Execution-store supplies the global set only after its authoritative membership,
 * grant, live-session, capacity, runtime capability and lease checks. */
export async function rankGlobalEligibleAgents(client:PoolClient,task:RoutingTask,candidates:Omit<RoutingCandidate,'accepted'|'rejected'>[]){
  const history=await routingHistory(client,candidates.map(candidate=>candidate.id));
  return rankEligibleAgents(task,candidates.map(candidate=>({...candidate,...(history.get(candidate.id)??{accepted:0,rejected:0})})));
}
