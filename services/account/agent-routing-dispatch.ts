import type {PoolClient} from 'pg';
import type {CodeBinding} from '../../packages/domain/code-transfer.ts';
import {rankGlobalEligibleAgents,type RoutingPreference} from './agent-routing.ts';

type DispatchWork={id:string;kind:'assess'|'execute';task_id:string;project_id:string;required_capabilities:string[]};
type Candidate={id:string;runnerId:string;profile:string;difficultyMin:number;difficultyMax:number;preference:RoutingPreference;relativeCost:number;occupied:number;capacityUnknown:boolean;maxConcurrency:number;runnerBusy:boolean};
type DispatchDecision={enabled:boolean;score:number;audit:unknown};

/** Returns null when another globally eligible Agent ranks ahead. Coding stays
 * local until a durable server-side repository-binding registry can prove that
 * a remote Runner can prepare this exact project. */
export async function preferredPollingAgent(client:PoolClient,work:DispatchWork,currentAgentId:string,currentRunnerId:string,codeBindings:CodeBinding[]){
  // Direct store consumers and older focused fixtures can intentionally stop
  // before migration 021. Production startup requires the full manifest, so
  // this compatibility path cannot silently disable routing there.
  const routingTable=(await client.query<{table:string|null}>("SELECT to_regclass('mas_business_routing_decision')::text AS table")).rows[0]?.table;
  if(!routingTable)return {enabled:false,score:1,audit:{kind:'legacy-current-agent'}} satisfies DispatchDecision;
  if(work.kind==='assess')return {enabled:true,score:1,audit:{kind:'coordinator'}} satisfies DispatchDecision;
  const assessment=(await client.query<{difficulty:number}>(`SELECT (result->>'difficulty')::int AS difficulty FROM mas_business_work
    WHERE task_id=$1 AND kind='assess' AND state='done' AND approved`,[work.task_id])).rows[0];
  if(!assessment)return null;
  const capability=work.required_capabilities.length===1?work.required_capabilities[0]:null;if(!capability)return null;
  const rows=await client.query<Candidate>(`SELECT a.id,a.runner_id AS "runnerId",a.profile,
    a.difficulty_min AS "difficultyMin",a.difficulty_max AS "difficultyMax",
    a.routing_preference AS preference,a.relative_cost AS "relativeCost",
    coalesce(cap.occupied,0)::int AS occupied,coalesce(cap.unknown,false) AS "capacityUnknown",
    coalesce(policy.max_concurrency,1)::int AS "maxConcurrency",
    EXISTS(SELECT 1 FROM mas_business_work_attempt busy WHERE busy.runner_id=a.runner_id AND busy.state IN ('assigned','running')) AS "runnerBusy"
    FROM mas_business_agent a JOIN mas_business_runner_device d ON d.id=a.runner_id AND d.owner_id=a.owner_id
    JOIN mas_business_agent_project g ON g.agent_id=a.id AND g.project_id=$1 AND g.enabled
    JOIN mas_business_project p ON p.id=g.project_id
    JOIN mas_business_membership om ON om.organization_id=p.organization_id AND om.user_id=a.owner_id AND om.status='active'
    JOIN mas_business_project_member pm ON pm.project_id=p.id AND pm.user_id=a.owner_id AND pm.status='active' AND pm.role<>'viewer'
    JOIN mas_business_user u ON u.id=a.owner_id AND u.status='active'
    LEFT JOIN mas_business_execution_policy policy ON policy.user_id=a.owner_id
    LEFT JOIN LATERAL (SELECT count(*)::int AS occupied,coalesce(bool_or(lease_until<=clock_timestamp()),false) AS unknown
      FROM mas_business_work_attempt used WHERE used.owner_id=a.owner_id AND used.state IN ('assigned','running')) cap ON true
    WHERE a.deleted_at IS NULL AND a.enabled AND d.revoked_at IS NULL AND d.session_until>clock_timestamp() AND a.ready_until>clock_timestamp() AND a.ready_session_hash=d.session_hash
      AND a.difficulty_min<=$2 AND a.difficulty_max>=$2
      AND (($3='coding' AND a.profile IN ('dsh-text','codex-code')) OR ($3='writing' AND a.profile IN ('demo','dsh-text','codex-code')))
    ORDER BY a.id`,[work.project_id,assessment.difficulty,capability]);
  const candidates=rows.rows.filter(row=>{
    if(row.capacityUnknown||row.occupied>=row.maxConcurrency||row.runnerBusy)return false;
    // Until bindings are durable server state, another Runner's coding checkout
    // cannot be inferred from the current caller's request.
    if(capability==='coding'&&(row.runnerId!==currentRunnerId||!codeBindings.some(binding=>binding.projectId===work.project_id)))return false;
    return true;
  }).map(row=>({id:row.id,authorized:true,online:true,capacityAvailable:true,
    capabilities:['writing','coding'],difficultyMin:row.difficultyMin,difficultyMax:row.difficultyMax,preference:row.preference,relativeCost:row.relativeCost}));
  const ranked=await rankGlobalEligibleAgents(client,{requiredCapabilities:[capability],difficulty:assessment.difficulty},candidates);
  return ranked[0]?.id===currentAgentId?{...ranked[0],enabled:true}:null;
}

export async function recordRoutingDecision(client:PoolClient,attemptId:string,workId:string,agentId:string,decision:DispatchDecision){
  if(!decision.enabled)return;
  await client.query(`INSERT INTO mas_business_routing_decision(attempt_id,work_id,agent_id,score,explanation)
    VALUES($1,$2,$3,$4,$5)`,[attemptId,workId,agentId,decision.score,decision.audit]);
}
