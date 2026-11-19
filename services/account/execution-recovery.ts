import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {projectTransaction} from './project-scope.ts';
import {recordStopped} from './execution-store.ts';
import {recordStoryStopped} from './story-assistance-runner.ts';

const root='/api/account/execution-recovery',command=/^\/api\/account\/execution-recovery\/([^/]+)\/confirm-stopped$/;
export function recoveryRoute(request:Request){const path=new URL(request.url).pathname;return request.method==='GET'&&path===root||request.method==='POST'&&command.test(path);}
export async function handleExecutionRecovery(pool:Pool,principal:IdentityPrincipal,request:Request){
  const write=request.method==='POST';
  const input=write?z.object({identityId:z.string().min(1).max(128),runnerId:z.uuid(),fence:z.number().int().min(1).max(16),confirmedStopped:z.literal(true)}).strict().parse(await readBoundedJson(request)):null;
  if(input&&input.identityId!==principal.id)throw 403;
  const attemptId=write?z.uuid().parse(command.exec(new URL(request.url).pathname)![1]):null;
  return projectTransaction(pool,async client=>{
    const user=(await client.query<{id:string;status:string}>(`SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR ${write?'UPDATE':'SHARE'}`,[principal.id])).rows[0];
    if(user&&user.status!=='active')throw 403;
    if(!input){
      const attempts=await client.query(`SELECT a.id AS "attemptId",a.runner_id AS "runnerId",a.fence,d.name AS "deviceName",
        d.revoked_at IS NOT NULL AS "deviceRevoked",a.lease_until<=clock_timestamp() AS "leaseExpired"
        FROM mas_business_work_attempt a JOIN mas_business_runner_device d ON d.id=a.runner_id
        WHERE a.owner_id=$1 AND a.state IN ('assigned','running')
        AND (d.revoked_at IS NOT NULL OR a.lease_until<=clock_timestamp() OR d.session_until IS NULL OR d.session_until<=clock_timestamp())
        ORDER BY a.created_at,a.id LIMIT 51`,[user?.id??null]);
      return {identityId:principal.id,attempts:attempts.rows.slice(0,50),hasMore:attempts.rows.length>50};
    }
    if(!user)throw 404;
    const device=(await client.query<{revoked_at:Date|null}>('SELECT revoked_at FROM mas_business_runner_device WHERE id=$1 AND owner_id=$2 FOR SHARE',[input.runnerId,user.id])).rows[0];
    if(!device)throw 404;
    const selected=(await client.query<{work_id:string|null;story_job_id:string|null}>("SELECT work_id,to_jsonb(a)->>'story_job_id' AS story_job_id FROM mas_business_work_attempt a WHERE id=$1 AND runner_id=$2 AND owner_id=$3 AND fence=$4",[attemptId,input.runnerId,user.id,input.fence])).rows[0];
    if(!selected)throw 404;
    const work=(await client.query<{id:string;kind:'assess'|'execute';task_id:string;project_id:string}>(`SELECT w.id,w.kind,w.task_id,t.project_id
      FROM mas_business_work w JOIN mas_business_task t ON t.id=w.task_id WHERE w.id=$1 FOR UPDATE OF w`,[selected.work_id])).rows[0];
    if(selected.story_job_id)await client.query('SELECT id FROM mas_business_story_assistance WHERE id=$1 FOR UPDATE',[selected.story_job_id]);
    const attempt=(await client.query<{id:string;state:string;coordinator_version:number|null;expired:boolean}>('SELECT id,state,coordinator_version,lease_until<=clock_timestamp() AS expired FROM mas_business_work_attempt WHERE id=$1 FOR UPDATE',[attemptId])).rows[0];
    const receipt=(await client.query('SELECT actor_id FROM mas_business_stop_confirmation WHERE attempt_id=$1',[attemptId])).rows[0];
    if(receipt){if(receipt.actor_id!==user.id)throw 409;return {identityId:principal.id,ok:true};}
    if(!['assigned','running'].includes(attempt.state)||(!device.revoked_at&&!attempt.expired))throw 409;
    await client.query('INSERT INTO mas_business_stop_confirmation(attempt_id,actor_id) VALUES($1,$2)',[attemptId,user.id]);
    if(selected.story_job_id)await recordStoryStopped(client,selected.story_job_id,attempt);
    else await recordStopped(client,work,attempt);
    return {identityId:principal.id,ok:true};
  });
}
