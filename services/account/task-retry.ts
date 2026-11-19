import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {authorizeProject,authorizeProjectContent,projectTransaction} from './project-scope.ts';

const pathPattern=/^\/api\/account\/projects\/([^/]+)\/tasks\/([^/]+)\/retry$/;
const inputSchema=z.object({identityId:z.string().min(1).max(128),requestId:z.uuid(),expectedRevision:z.number().int().min(1).max(4),expectedAttemptId:z.uuid()}).strict();
const retryLimit=3;
export function taskRetryRoute(request:Request){return ['GET','POST'].includes(request.method)&&pathPattern.test(new URL(request.url).pathname);}

export async function handleTaskRetry(pool:Pool,principal:IdentityPrincipal,request:Request){
  if(!taskRetryRoute(request))throw 404;
  const path=pathPattern.exec(new URL(request.url).pathname)!,projectId=z.uuid().parse(path[1]),taskId=z.uuid().parse(path[2]);
  const input=request.method==='POST'?inputSchema.parse(await readBoundedJson(request,4096)):null;
  if(input&&input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    const user=input?await authorizeProject(client,principal.id,projectId,true):await authorizeProjectContent(client,principal.id,projectId);
    const owner=(await client.query<{owner_id:string}>('SELECT owner_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0];
    const isOwner=owner.owner_id===user.id&&user.projectRole==='owner';
    if(input&&!isOwner)throw 403;
    if(!(await client.query(`SELECT b.id FROM mas_business_board b JOIN mas_business_task t ON t.board_id=b.id
      WHERE t.id=$1 AND t.project_id=$2 AND b.project_id=$2 AND b.archived_at IS NULL FOR SHARE OF b`,[taskId,projectId])).rowCount)throw 404;
    // Match the execution/rework lock order: work rows precede the task row.
    // The work lock serializes dispatch, stop, review and both retry commands.
    const work=(await client.query(`SELECT w.* FROM mas_business_work w JOIN mas_business_task t ON t.id=w.task_id
      WHERE w.task_id=$1 AND t.project_id=$2 ORDER BY w.id ${input?'FOR UPDATE OF w':''}`,[taskId,projectId])).rows;
    const task=(await client.query(`SELECT status,input_revision,required_capabilities FROM mas_business_task
      WHERE id=$1 AND project_id=$2 ${input?'FOR UPDATE':''}`,[taskId,projectId])).rows[0];
    if(!task)throw 404;
    const digest=input?createHash('sha256').update(JSON.stringify({projectId,taskId,...input})).digest('hex'):null;
    if(input){
      const receipt=(await client.query('SELECT task_id,request_hash FROM mas_business_task_retry WHERE actor_id=$1 AND request_id=$2',[user.id,input.requestId])).rows[0];
      if(receipt){if(receipt.task_id!==taskId||receipt.request_hash!==digest)throw 409;return {identityId:principal.id,ok:true as const};}
    }
    const execution=work.find(value=>value.kind==='execute'),assessment=work.find(value=>value.kind==='assess');
    const attempt=execution?(await client.query('SELECT id,state,input_revision,fence FROM mas_business_work_attempt WHERE work_id=$1 AND fence=$2',[execution.id,execution.calls])).rows[0]:null;
    const unsettled=Boolean((await client.query(`SELECT 1 FROM mas_business_work_attempt a JOIN mas_business_work w ON w.id=a.work_id
      WHERE w.task_id=$1 AND a.state IN ('assigned','running') LIMIT 1`,[taskId])).rowCount);
    const retryCount=Number((await client.query('SELECT count(*)::int AS count FROM mas_business_task_retry WHERE task_id=$1 AND input_revision=$2',[taskId,task.input_revision])).rows[0].count);
    const reason=!isOwner?'owner_required':unsettled?'unsettled':task.status!=='failed'||execution?.state!=='failed'?'not_failed':
      !attempt||attempt.state!=='stopped'||attempt.input_revision!==task.input_revision||attempt.fence<=execution.round_start_calls?'attempt_not_stopped':
      retryCount>=retryLimit||execution.calls>=16?'retry_limit':
      assessment?.state!=='done'||!assessment.approved||task.required_capabilities.length!==1||assessment.result?.requiredCapability!==task.required_capabilities[0]?'assessment_required':null;
    if(!input)return {identityId:principal.id,taskId,revision:task.input_revision,attemptId:attempt?.id??null,canRetry:reason===null,reason,retryCount,retryLimit};
    if(reason||input.expectedRevision!==task.input_revision||input.expectedAttemptId!==attempt?.id)throw 409;
    await client.query(`INSERT INTO mas_business_task_retry(attempt_id,task_id,input_revision,actor_id,request_id,request_hash,previous)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[attempt.id,taskId,task.input_revision,user.id,input.requestId,digest,JSON.stringify(execution)]);
    await client.query("UPDATE mas_business_work SET state='queued',round_start_calls=calls,result=NULL,issues='[]'::jsonb,deadline_at=NULL WHERE id=$1",[execution.id]);
    await client.query("UPDATE mas_business_task SET status='pending' WHERE id=$1",[taskId]);
    return {identityId:principal.id,ok:true as const};
  });
}
