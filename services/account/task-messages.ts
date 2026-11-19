import type {Pool,PoolClient} from 'pg';
import type {IdentityPrincipal} from '../identity/service.ts';
import {projectTransaction,authorizeProject} from './project-scope.ts';
import {taskMessageInputSchema,taskMessageSchema,taskMessageReceiptSchema} from '../../packages/domain/task-conversation.ts';
import type {z} from 'zod';

type Message={id:string;attempt_id:string;author_id:string;author_name:string;body:string;state:string;error:string|null;created_at:Date;claimed_at:Date|null};
const messageFields='m.*,u.name AS author_name';
function present(message:Message,ended:boolean){
  const uncertain=message.state==='delivering'&&(ended||!!message.claimed_at&&Date.now()-message.claimed_at.getTime()>30_000);
  return taskMessageSchema.parse({id:message.id,authorName:message.author_name,body:message.body,createdAt:message.created_at.toISOString(),
    state:ended&&message.state==='queued'?'rejected':uncertain?'unknown':message.state,
    error:ended&&message.state==='queued'?'execution_ended':uncertain?'unconfirmed':message.error});
}

async function readiness(client:PoolClient,attemptId:string){
  return (await client.query<{state:string;work_state:string;profile:string;current:boolean;connected:boolean;authorized:boolean;ready:boolean}>(`SELECT a.state,w.state AS work_state,g.profile,w.calls=a.fence AS current,
    (a.lease_until>clock_timestamp() AND d.revoked_at IS NULL AND d.session_until>clock_timestamp()) IS TRUE AS connected,
    (a.message_ready_until>clock_timestamp()) IS TRUE AS ready,
    (g.enabled AND g.deleted_at IS NULL AND u.status='active' AND om.status='active' AND pm.status='active' AND pm.role<>'viewer' AND ag.enabled
      AND b.archived_at IS NULL AND cardinality(t.required_capabilities)=1
      AND EXISTS(SELECT 1 FROM mas_business_work assessment WHERE assessment.task_id=t.id AND assessment.kind='assess' AND assessment.state='done'
        AND assessment.approved AND assessment.result->>'requiredCapability'=t.required_capabilities[1])
      AND NOT EXISTS(SELECT 1 FROM mas_business_task_dependency dep JOIN mas_business_task prerequisite ON prerequisite.id=dep.depends_on_id WHERE dep.task_id=t.id AND prerequisite.status<>'done')) IS TRUE AS authorized
    FROM mas_business_work_attempt a JOIN mas_business_work w ON w.id=a.work_id AND w.kind='execute'
    JOIN mas_business_task t ON t.id=w.task_id JOIN mas_business_project p ON p.id=t.project_id
    JOIN mas_business_board b ON b.id=t.board_id AND b.project_id=p.id
    JOIN mas_business_agent g ON g.id=a.agent_id JOIN mas_business_runner_device d ON d.id=a.runner_id
    JOIN mas_business_user u ON u.id=a.owner_id
    LEFT JOIN mas_business_membership om ON om.organization_id=p.organization_id AND om.user_id=u.id
    LEFT JOIN mas_business_project_member pm ON pm.project_id=p.id AND pm.user_id=u.id
    LEFT JOIN mas_business_agent_project ag ON ag.agent_id=g.id AND ag.project_id=p.id
    WHERE a.id=$1`,[attemptId])).rows[0];
}

export async function readTaskMessaging(client:PoolClient,attemptId:string|null,role:string){
  const ready=attemptId?await readiness(client,attemptId):undefined;
  const rows=attemptId?(await client.query<Message>(`SELECT ${messageFields} FROM mas_business_task_message m JOIN mas_business_user u ON u.id=m.author_id WHERE m.attempt_id=$1 ORDER BY m.created_at,m.id LIMIT 50`,[attemptId])).rows:[];
  const ended=!ready||!ready.current||ready.state!=='running'||ready.work_state!=='active';
  const reason=role==='viewer'?'read_only':ended?'not_running':ready.profile!=='codex-code'?'unsupported':!ready.connected?'offline':!ready.authorized||!ready.ready?'unavailable':rows.length>=50?'limit':null;
  return {canSend:reason===null,reason,messages:rows.map(row=>present(row,ended))};
}

export async function enqueueTaskMessage(pool:Pool,principal:IdentityPrincipal,projectId:string,taskId:string,input:z.infer<typeof taskMessageInputSchema>){
  if(input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    const actor=await authorizeProject(client,principal.id,projectId,true);
    if(!(await client.query(`SELECT 1 FROM mas_business_task t JOIN mas_business_board b ON b.id=t.board_id AND b.project_id=t.project_id
      WHERE t.id=$1 AND t.project_id=$2 AND b.archived_at IS NULL`,[taskId,projectId])).rowCount)throw 404;
    const work=(await client.query<{id:string;calls:number}>("SELECT id,calls FROM mas_business_work WHERE task_id=$1 AND kind='execute' FOR UPDATE",[taskId])).rows[0];
    if(!work)throw 409;
    const previous=(await client.query<Message&{work_id:string;attempt_state:string}>(`SELECT ${messageFields},a.work_id,a.state AS attempt_state FROM mas_business_task_message m
      JOIN mas_business_user u ON u.id=m.author_id JOIN mas_business_work_attempt a ON a.id=m.attempt_id WHERE m.id=$1`,[input.requestId])).rows[0];
    const receipt=(message:Message,ended:boolean)=>taskMessageReceiptSchema.parse({identityId:principal.id,projectId,taskId,attemptId:input.attemptId,message:present(message,ended)});
    if(previous){
      if(previous.work_id!==work.id||previous.attempt_id!==input.attemptId||previous.author_id!==actor.id||previous.body!==input.body)throw 409;
      return receipt(previous,previous.attempt_state!=='running');
    }
    const attempt=(await client.query<{id:string}>('SELECT id FROM mas_business_work_attempt WHERE work_id=$1 AND fence=$2 FOR UPDATE',[work.id,work.calls])).rows[0];
    if(attempt?.id!==input.attemptId)throw 409;
    const ready=await readiness(client,attempt.id);
    if(!ready||ready.state!=='running'||ready.work_state!=='active'||!ready.current||!ready.connected||!ready.authorized||!ready.ready||ready.profile!=='codex-code')throw 409;
    if(Number((await client.query('SELECT count(*) AS count FROM mas_business_task_message WHERE attempt_id=$1',[attempt.id])).rows[0].count)>=50)throw 429;
    const message=(await client.query<Omit<Message,'author_name'>>(`INSERT INTO mas_business_task_message(id,attempt_id,author_id,body) VALUES($1,$2,$3,$4) RETURNING *`,[input.requestId,attempt.id,actor.id,input.body])).rows[0];
    return receipt({...message,author_name:(await client.query<{name:string}>('SELECT name FROM mas_business_user WHERE id=$1',[actor.id])).rows[0].name},false);
  });
}
