import type {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {projectTransaction,authorizeProject} from './project-scope.ts';
import {agentRuntimeProjection} from './agent-runtime-projection.ts';

const route=/^\/api\/account\/projects\/([^/]+)\/coordinator(\/resume|\/agents)?$/;
const uuid=z.uuid().transform(s=>s.toLowerCase());
const schema=z.object({identityId:z.string().min(1).max(128),agentId:uuid.nullable(),expectedVersion:z.number().int().min(0),authorize:z.literal(true).optional()}).strict();
export function coordinatorRoute(request:Request){const match=route.exec(new URL(request.url).pathname);return !!match&&((request.method==='POST'&&match[2]!=='/agents')||(request.method==='GET'&&match[2]!=='/resume'));}
export async function handleCoordinatorRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  const matched=route.exec(new URL(request.url).pathname)!;
  const projectId=uuid.parse(matched[1]);
  if(matched[2]==='/agents')return projectTransaction(pool,async client=>{
    await authorizeProject(client,principal.id,projectId,false);
    const owner=(await client.query<{id:string;name:string}>(`SELECT u.id,u.name FROM mas_business_project p
      JOIN mas_business_user u ON u.id=p.owner_id WHERE p.id=$1`,[projectId])).rows[0];
    const agents=await client.query(`SELECT a.id,a.name,a.profile,a.model,a.enabled,d.name AS "deviceName",d.revoked_at IS NOT NULL AS revoked,${agentRuntimeProjection}
      FROM mas_business_agent a JOIN mas_business_runner_device d ON d.id=a.runner_id
      WHERE a.owner_id=$1 AND a.deleted_at IS NULL ORDER BY a.created_at,a.id`,[owner.id]);
    return {identityId:principal.id,projectId,ownerName:owner.name,agents:agents.rows};
  });
  if(matched[2]==='/resume')return resumeCoordinator(pool,principal,request,projectId);
  const input=request.method==='POST'?schema.parse(await readBoundedJson(request)):null;
  if(input&&input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,principal.id,projectId,!!input);
    const project=(await client.query<{owner_id:string}>('SELECT owner_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0];
    if(input&&project.owner_id!==user.id)throw 403;
    const current=(await client.query<{agent_id:string|null;version:number;paused:boolean;pause_reason:string|null}>(`SELECT agent_id,version,paused,pause_reason FROM mas_business_project_coordinator WHERE project_id=$1 FOR ${input?'UPDATE':'SHARE'}`,[projectId])).rows[0]??{agent_id:null,version:0,paused:false,pause_reason:null};
    if(input){
      const updating=current.version===input.expectedVersion;
      if(!updating&&!(current.version===input.expectedVersion+1&&current.agent_id===input.agentId))throw 409;
      if(input.agentId){
        const resource=(await client.query<{enabled:boolean;profile:string;revoked_at:Date|null}>(`SELECT a.enabled,a.profile,d.revoked_at
          FROM mas_business_agent a JOIN mas_business_runner_device d ON d.id=a.runner_id
          WHERE a.id=$1 AND a.owner_id=$2 AND a.deleted_at IS NULL FOR SHARE OF a,d`,[input.agentId,user.id])).rows[0];
        if(!resource)throw 404;
        if(!resource.enabled||resource.revoked_at||!['dsh-text','codex-code'].includes(resource.profile))throw 403;
        const grant=(await client.query<{enabled:boolean}>('SELECT enabled FROM mas_business_agent_project WHERE agent_id=$1 AND project_id=$2 FOR UPDATE',[input.agentId,projectId])).rows[0];
        if(!grant?.enabled){
          if(!input.authorize||!updating)throw 403;
          // Explicit owner selection grants and configures in the same transaction.
          await client.query(`INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled,version)
            VALUES($1,$2,$3,true,1) ON CONFLICT(agent_id,project_id) DO UPDATE SET enabled=true,version=mas_business_agent_project.version+1`,[input.agentId,user.id,projectId]);
        }
      }
      if(current.version===input.expectedVersion){
        await client.query(`INSERT INTO mas_business_project_coordinator(project_id,owner_id,agent_id,version) VALUES($1,$2,$3,$4)
          ON CONFLICT(project_id) DO UPDATE SET agent_id=excluded.agent_id,version=excluded.version,last_resume_version=NULL`,[projectId,user.id,input.agentId,current.version+1]);
        current.agent_id=input.agentId;current.version++;
      }else if(!(current.version===input.expectedVersion+1&&current.agent_id===input.agentId))throw 409;
    }
    const status=(await client.query(`SELECT a.enabled,
      (a.enabled AND d.revoked_at IS NULL AND d.session_until>clock_timestamp() AND a.ready_until>clock_timestamp()
        AND a.ready_session_hash=d.session_hash AND g.enabled) IS TRUE AS available
      FROM mas_business_agent a JOIN mas_business_runner_device d ON d.id=a.runner_id
      LEFT JOIN mas_business_agent_project g ON g.agent_id=a.id AND g.project_id=$2 WHERE a.id=$1`,[current.agent_id,projectId])).rows[0];
    return {identityId:principal.id,coordinator:{agentId:current.agent_id,version:current.version,available:!current.paused&&(status?.available??false),paused:current.paused,pauseReason:current.pause_reason}};
  });
}

async function resumeCoordinator(pool:Pool,principal:IdentityPrincipal,request:Request,projectId:string){
  const input=z.object({identityId:z.string().min(1).max(128),expectedVersion:z.number().int().min(1)}).strict().parse(await readBoundedJson(request));
  if(input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,principal.id,projectId,true);
    if((await client.query('SELECT owner_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0].owner_id!==user.id)throw 403;
    const current=(await client.query<{version:number;paused:boolean;last_resume_version:number|null;agent_id:string|null}>('SELECT version,paused,last_resume_version,agent_id FROM mas_business_project_coordinator WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];
    if(!current)throw 404;
    if(current.version===input.expectedVersion+1&&!current.paused&&current.last_resume_version===input.expectedVersion)return {identityId:principal.id,ok:true};
    if(current.version!==input.expectedVersion||!current.paused||!current.agent_id)throw 409;
    if((await client.query(`SELECT 1 FROM mas_business_work w JOIN mas_business_task t ON t.id=w.task_id
      WHERE t.project_id=$1 AND w.kind='assess' AND w.state='active' LIMIT 1`,[projectId])).rowCount)throw 409;
    if((await client.query("SELECT to_regclass('mas_business_story_assistance') AS table_name")).rows[0].table_name&&
      (await client.query(`SELECT 1 FROM mas_business_story_assistance j JOIN mas_business_work_attempt a ON a.story_job_id=j.id
        WHERE j.project_id=$1 AND a.state IN ('assigned','running') LIMIT 1`,[projectId])).rowCount)throw 409;
    await client.query('UPDATE mas_business_project_coordinator SET paused=false,pause_reason=NULL,version=version+1,last_resume_version=$2 WHERE project_id=$1',[projectId,input.expectedVersion]);
    const affected=await client.query<{id:string;revision:number}>(`SELECT t.id,coalesce((to_jsonb(t)->>'input_revision')::integer,1) AS revision FROM mas_business_task t JOIN mas_business_work w ON w.task_id=t.id WHERE t.project_id=$1 AND w.kind='assess' AND w.state='failed'`,[projectId]);
    for(const task of affected.rows)await client.query("INSERT INTO mas_business_task_transition(id,task_id,actor_id,operation,input_revision) VALUES($1,$2,$3,'coordinator_resume',$4)",[randomUUID(),task.id,user.id,task.revision]);
    return {identityId:principal.id,ok:true};
  });
}
