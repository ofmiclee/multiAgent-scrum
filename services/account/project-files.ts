import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {authorizeProject,projectTransaction} from './project-scope.ts';
import {authorizeRunnerSession,runnerCredential,runnerSessionSchema} from './runner-connections.ts';
import {projectContextSchema,projectFilesWriteSchema,personalProjectWriteSchema,publicProjectConfig,publicProjectEnv,projectFileLimit,setupResultSchema} from '../../packages/domain/project-files.ts';
import type {ProjectSecrets} from './project-secrets.ts';

type Personal={directory:string;gitUsername:string;gitToken:string;deploymentAccess:boolean};
const scope=(projectId:string,userId:string,runnerId:string)=>`personal:${projectId}:${userId}:${runnerId}`;
const route=/^\/api\/account\/projects\/([^/]+)\/files(?:\/(editor|personal|initialize|sync))?$/;
export function projectFilesRoute(request:Request){return ['GET','POST'].includes(request.method)&&route.test(new URL(request.url).pathname);}
async function isOwner(client:PoolClient,projectId:string,userId:string){
  return (await client.query('SELECT 1 FROM mas_business_project WHERE id=$1 AND owner_id=$2',[projectId,userId])).rows.length>0;
}
async function latest(client:PoolClient,projectId:string){
  return (await client.query('SELECT * FROM mas_business_project_files WHERE project_id=$1 ORDER BY version DESC LIMIT 1',[projectId])).rows[0];
}
export async function readProjectContext(client:PoolClient,projectId:string){
  const row=await latest(client,projectId);
  return row?projectContextSchema.parse({projectId,version:row.version,agentsMd:row.agents_md,config:row.public_config}):undefined;
}
async function expireJobs(client:PoolClient,runnerId?:string){
  // Expiry records uncertainty as a failure. It never silently retries filesystem work.
  await client.query(`UPDATE mas_business_project_setup SET state='failed',result='cancelled',updated_at=clock_timestamp()
    WHERE ($1::uuid IS NULL OR runner_id=$1) AND ((state='running' AND lease_until<=clock_timestamp())
      OR (state='queued' AND created_at<clock_timestamp()-interval '1 day'))`,[runnerId??null]);
}
export async function handleProjectFiles(pool:Pool,principal:IdentityPrincipal,request:Request,secrets:ProjectSecrets){
  const match=route.exec(new URL(request.url).pathname)!;
  const projectId=z.uuid().parse(match[1]),action=match[2],write=request.method==='POST';
  const raw=write?await readBoundedJson(request,projectFileLimit):undefined;
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,principal.id,projectId,write);
    const owner=await isOwner(client,projectId,user.id);
    if(write){
      // The project row serializes revisions across owner handovers and requests.
      await client.query('SELECT id FROM mas_business_project WHERE id=$1 FOR UPDATE',[projectId]);
      if(!action){
        if(!owner)throw 403;
        const input=projectFilesWriteSchema.parse(raw),previous=await latest(client,projectId);
        if(input.expectedVersion!==(previous?.version??0))throw 409;
        let config;try{config=publicProjectConfig(input.env);}catch{throw 400;}
        if(Buffer.byteLength(input.agentsMd)>8000)throw 413;
        const version=input.expectedVersion+1;
        await client.query(`INSERT INTO mas_business_project_files(project_id,version,agents_md,public_config,encrypted_env,created_by)
          VALUES($1,$2,$3,$4,$5,$6)`,[projectId,version,input.agentsMd,config,secrets.seal(input.env,`files:${projectId}:${version}`),user.id]);
        return {ok:true,version};
      }
      if(action==='personal'){
        const input=personalProjectWriteSchema.parse(raw);
        if(input.deploymentAccess&&!owner)throw 403;
        const device=(await client.query('SELECT id FROM mas_business_runner_device WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL FOR SHARE',[input.runnerId,user.id])).rows[0];
        if(!device)throw 404;
        const previous=(await client.query('SELECT * FROM mas_business_project_personal WHERE project_id=$1 AND user_id=$2 AND runner_id=$3 FOR UPDATE',[projectId,user.id,input.runnerId])).rows[0];
        if(input.expectedVersion!==(previous?.version??0))throw 409;
        const key=scope(projectId,user.id,input.runnerId),old=previous?secrets.open<Personal>(previous.encrypted_settings,key):undefined;
        const settings:Personal={directory:input.directory,gitUsername:input.gitUsername,gitToken:input.gitToken??old?.gitToken??'',deploymentAccess:input.deploymentAccess};
        await client.query(`INSERT INTO mas_business_project_personal(project_id,user_id,runner_id,version,encrypted_settings)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(project_id,user_id,runner_id)
          DO UPDATE SET version=excluded.version,encrypted_settings=excluded.encrypted_settings`,[projectId,user.id,input.runnerId,input.expectedVersion+1,secrets.seal(settings,key)]);
        return {ok:true};
      }
      if(action==='initialize'||action==='sync'){
        const input=z.object({runnerId:z.uuid(),requestId:z.uuid(),expectedVersion:z.number().int().positive(),personalVersion:z.number().int().positive()}).strict().parse(raw);
        const device=(await client.query('SELECT id FROM mas_business_runner_device WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL FOR UPDATE',[input.runnerId,user.id])).rows[0];
        if(!device)throw 404;
        const hash=createHash('sha256').update(JSON.stringify({projectId,userId:user.id,action,...input})).digest('hex');
        const replay=(await client.query('SELECT request_hash FROM mas_business_project_setup WHERE id=$1',[input.requestId])).rows[0];
        if(replay){if(replay.request_hash!==hash)throw 409;return {ok:true};}
        const config=await latest(client,projectId);
        const personal=(await client.query('SELECT * FROM mas_business_project_personal WHERE project_id=$1 AND user_id=$2 AND runner_id=$3',[projectId,user.id,input.runnerId])).rows[0];
        if(!config||!personal||config.version!==input.expectedVersion||personal.version!==input.personalVersion)throw 409;
        if(!config.public_config.repositoryUrl)throw 428;
        const settings=secrets.open<Personal>(personal.encrypted_settings,scope(projectId,user.id,input.runnerId));
        if(settings.deploymentAccess&&!owner)throw 403;
        await expireJobs(client,input.runnerId);
        await client.query(`INSERT INTO mas_business_project_setup(id,project_id,user_id,runner_id,config_version,request_hash,encrypted_settings,mode)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[input.requestId,projectId,user.id,input.runnerId,config.version,hash,secrets.seal(settings,`job:${input.requestId}`),action]);
        return {ok:true};
      }
      throw 404;
    }
    const config=await latest(client,projectId);
    if(action==='editor'){
      if(!owner)throw 403;
      return {version:config?.version??0,agentsMd:config?.agents_md??'',env:config?secrets.open<string>(config.encrypted_env,`files:${projectId}:${config.version}`):''};
    }
    if(action)throw 404;
    await expireJobs(client);
    const personal=(await client.query('SELECT * FROM mas_business_project_personal WHERE project_id=$1 AND user_id=$2',[projectId,user.id])).rows;
    const jobs=(await client.query(`SELECT id,runner_id AS "runnerId",config_version AS version,
      CASE WHEN state='running' AND lease_until<=clock_timestamp() THEN 'failed' ELSE state END AS state,
      CASE WHEN state='running' AND lease_until<=clock_timestamp() THEN 'cancelled' ELSE result END AS result,updated_at
      FROM mas_business_project_setup WHERE project_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 20`,[projectId,user.id])).rows;
    return {version:config?.version??0,config:config?.public_config??null,canEdit:owner,
      personal:personal.map(row=>{
        const value=secrets.open<Personal>(row.encrypted_settings,scope(projectId,user.id,row.runner_id));
        return {runnerId:row.runner_id,directory:value.directory,gitUsername:value.gitUsername,hasGitToken:!!value.gitToken,deploymentAccess:value.deploymentAccess,version:row.version};
      }),jobs:jobs.map(({updated_at,...job})=>({...job,updatedAt:updated_at.toISOString()}))};
  });
}

export async function handleProjectSetupRunner(pool:Pool,request:Request,secrets:ProjectSecrets){
  if(request.method!=='POST')throw 404;
  const action=new URL(request.url).pathname.split('/').at(-1);
  const body=await readBoundedJson(request,8192),credential=runnerCredential(request);
    const base=action==='poll'?runnerSessionSchema:runnerSessionSchema.extend({id:z.uuid(),...(action==='finish'?{result:setupResultSchema}:{})}).strict();
  const input=base.parse(body);
  if(!['poll','renew','finish'].includes(action!))throw 404;
  return projectTransaction(pool,async client=>{
    const context=await authorizeRunnerSession(client,input,credential);
    await expireJobs(client,input.runnerId);
    if(action==='poll'){
      const active=(await client.query("SELECT 1 FROM mas_business_work_attempt WHERE runner_id=$1 AND state IN ('assigned','running') LIMIT 1",[input.runnerId])).rowCount;
      if(active)return {job:null};
      const job=(await client.query("SELECT * FROM mas_business_project_setup WHERE runner_id=$1 AND user_id=$2 AND state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE",[input.runnerId,context.user.id])).rows[0];
      if(!job)return {job:null};
      const settings=secrets.open<Personal>(job.encrypted_settings,`job:${job.id}`);
      try{
        await authorizeProject(client,context.user.identity_id,job.project_id,true);
        if(settings.deploymentAccess&&!await isOwner(client,job.project_id,context.user.id))throw 403;
      }catch(error){if(![403,404].includes(error as number))throw error;
        await client.query("UPDATE mas_business_project_setup SET state='failed',result='cancelled',updated_at=clock_timestamp() WHERE id=$1",[job.id]);return {job:null};}
      const config=(await client.query('SELECT * FROM mas_business_project_files WHERE project_id=$1 AND version=$2',[job.project_id,job.config_version])).rows[0];
      await client.query("UPDATE mas_business_project_setup SET state='running',session_hash=$2,lease_until=clock_timestamp()+interval '45 seconds',updated_at=clock_timestamp() WHERE id=$1",[job.id,context.device.session_hash]);
      return {job:{id:job.id,projectId:job.project_id,runnerId:input.runnerId,version:job.config_version,mode:job.mode,agentsMd:config.agents_md,config:config.public_config,
        env:settings.deploymentAccess?secrets.open<string>(config.encrypted_env,`files:${job.project_id}:${job.config_version}`):publicProjectEnv(config.public_config),
        directory:settings.directory,gitUsername:settings.gitUsername,gitToken:settings.gitToken}};
    }
    const job=(await client.query('SELECT * FROM mas_business_project_setup WHERE id=$1 AND runner_id=$2 AND user_id=$3 FOR UPDATE',[('id' in input)?input.id:undefined,input.runnerId,context.user.id])).rows[0];
    if(!job||job.session_hash!==context.device.session_hash)throw 409;
    await authorizeProject(client,context.user.identity_id,job.project_id,true);
    const settings=secrets.open<Personal>(job.encrypted_settings,`job:${job.id}`);
    if(settings.deploymentAccess&&!await isOwner(client,job.project_id,context.user.id))throw 403;
    if(action==='finish'){
      const result=setupResultSchema.parse('result' in input?input.result:undefined);
      if(['ready','failed'].includes(job.state)){if(job.result!==result)throw 409;return {ok:true};}
      if(job.state!=='running')throw 409;
      await client.query('UPDATE mas_business_project_setup SET state=$2,result=$3,updated_at=clock_timestamp() WHERE id=$1',[job.id,result==='ok'?'ready':'failed',result]);
      return {ok:true};
    }
    if(job.state!=='running')throw 409;
    await client.query("UPDATE mas_business_project_setup SET lease_until=clock_timestamp()+interval '45 seconds' WHERE id=$1",[job.id]);
    return {ok:true};
  });
}
