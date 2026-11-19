import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {runnerProfileSchema,runnerCredentialSchema,type RunnerProfile} from '../../packages/domain/runner-protocol.ts';
import {codeBindingSchema,type CodeBinding} from '../../packages/domain/code-transfer.ts';
import {projectTransaction,authorizeProject} from './project-scope.ts';
import {runnerCredential,runnerSessionSchema,authorizeRunnerSession} from './runner-connections.ts';
import {modelChoiceSchema,modelIdSchema,modelDirectorySchema,modelRoutingDefaults} from '../../packages/domain/agent-models.ts';
import {agentRuntimeProjection} from './agent-runtime-projection.ts';

export async function announceAgent(pool:Pool,request:Request,profiles:readonly RunnerProfile[],
  offer?:(client:PoolClient,context:Awaited<ReturnType<typeof authorizeRunnerSession>>,agentId:string|null,profile:RunnerProfile,codeBindings?:CodeBinding[])=>Promise<unknown>){
  if(request.method!=='POST'||new URL(request.url).pathname!=='/api/runner/tasks/poll')throw 404;
  const digest=runnerCredential(request);
  const input=runnerSessionSchema.extend({profile:runnerProfileSchema,codeBindings:z.array(codeBindingSchema).max(10).default([]),
    readyProfiles:z.array(runnerProfileSchema).max(2).optional(),credentials:z.array(runnerCredentialSchema).max(40).optional(),announceOnly:z.boolean().optional(),
    localConfig:z.object({port:z.number().int().min(1).max(65535),token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().optional()}).strict().parse(await readBoundedJson(request,16384));
  if(input.profile==='demo'&&input.codeBindings.length)throw 400;
  if(new Set(input.codeBindings.map(b=>b.projectId)).size!==input.codeBindings.length)throw 400;
  if(!input.announceOnly&&!profiles.includes(input.profile))throw 503;
  const requested=input.readyProfiles??[input.profile];
  if(new Set(requested).size!==requested.length||(!input.announceOnly&&!requested.includes(input.profile)))throw 400;
  // Availability cannot turn on a server-disabled runtime or prevent another
  // allowed runtime on this device from receiving work.
  const ready=requested.filter(profile=>profiles.includes(profile));
  const credentials=input.credentials??ready.filter(profile=>profile!=='demo').map(profile=>({id:'legacy' as const,profile,kind:profile==='codex-code'?'subscription' as const:'api-key' as const,label:profile==='codex-code'?'本机 Codex 账号':'本机 DSH API Key'}));
  if(new Set(credentials.map(item=>item.profile+':'+item.id)).size!==credentials.length||credentials.some(item=>!ready.includes(item.profile)))throw 400;
  return projectTransaction(pool,async client=>{
    const context=await authorizeRunnerSession(client,input,digest),{user,device,now}=context;
    await client.query(`UPDATE mas_business_runner_device SET local_config_port=$2,local_config_token=$3,
      local_config_seen=CASE WHEN $2::integer IS NULL THEN NULL ELSE clock_timestamp() END WHERE id=$1`,
      [device.id,input.localConfig?.port??null,input.localConfig?.token??null]);
    for(const item of credentials)await client.query(`INSERT INTO mas_business_runner_credential(runner_id,owner_id,id,profile,kind,label,seen_at)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(runner_id,profile,id) DO UPDATE SET
      kind=excluded.kind,label=excluded.label,seen_at=excluded.seen_at`,
      [device.id,user.id,item.id,item.profile,item.kind,item.label]);
    // A Runner declares only which runtimes are currently ready. It never
    // creates an Agent; only the owner can create an explicit configuration.
    await client.query(`UPDATE mas_business_agent SET ready_until=to_timestamp(0)
      WHERE runner_id=$1 AND owner_id=$2 AND deleted_at IS NULL`,[device.id,user.id]);
    if(ready.includes('demo'))await client.query(`UPDATE mas_business_agent SET ready_until=$3,ready_session_hash=$4
      WHERE runner_id=$1 AND owner_id=$2 AND profile='demo' AND deleted_at IS NULL`,
    [device.id,user.id,new Date(now+10_000),device.session_hash]);
    for(const item of credentials)await client.query(`UPDATE mas_business_agent SET ready_until=$5,ready_session_hash=$6
      WHERE runner_id=$1 AND owner_id=$2 AND profile=$3 AND credential_id=$4 AND deleted_at IS NULL`,
    [device.id,user.id,item.profile,item.id,new Date(now+10_000),device.session_hash]);
    return !input.announceOnly&&offer?await offer(client,context,null,input.profile,input.codeBindings):null;
  });
}

export async function listAgents(pool:Pool,principal:IdentityPrincipal,projectId?:string){
  return projectTransaction(pool,async client=>{
    if(projectId)await authorizeProject(client,principal.id,projectId,false);
    const user=(await client.query<{id:string;status:string}>('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR SHARE',[principal.id])).rows[0];
    if(user&&user.status!=='active')throw 403;
    const agents=await client.query(`SELECT a.id,a.name,a.instructions,a.model,a.runner_id AS "runnerId",d.name AS "deviceName",a.profile,a.enabled,a.version,a.credential_id AS "credentialId",c.label AS "credentialLabel",c.kind AS "credentialKind",
      a.max_concurrency AS "maxConcurrency",d.revoked_at IS NOT NULL AS revoked,
      ${agentRuntimeProjection},
      coalesce((SELECT jsonb_agg(jsonb_build_object('projectId',g.project_id,'enabled',g.enabled,'version',g.version) ORDER BY g.project_id)
        FROM mas_business_agent_project g JOIN mas_business_project p ON p.id=g.project_id
        JOIN mas_business_membership m ON m.organization_id=p.organization_id AND m.user_id=g.owner_id AND m.status='active'
        JOIN mas_business_project_member pm ON pm.project_id=p.id AND pm.user_id=g.owner_id AND pm.status='active'
        WHERE g.agent_id=a.id),'[]'::jsonb) AS "projectGrants"
      FROM mas_business_agent a JOIN mas_business_runner_device d ON d.id=a.runner_id
      LEFT JOIN mas_business_runner_credential c ON c.runner_id=a.runner_id AND c.profile=a.profile AND c.id=a.credential_id
      WHERE a.owner_id=$1 AND a.deleted_at IS NULL ORDER BY a.created_at,a.id`,[user?.id??null]);
    return {identityId:principal.id,agents:agents.rows};
  });
}

const agentPath=/^\/api\/account\/agents\/([^/]+)$/;
const grantPath=/^\/api\/account\/projects\/([^/]+)\/agent-grants$/;
const projectAgentsPath=/^\/api\/account\/projects\/([^/]+)\/agents$/;
const localConfigPath=/^\/api\/account\/runner-local-config\/([^/]+)$/;
const change=z.object({identityId:z.string().min(1).max(128),expectedVersion:z.number().int().min(0),enabled:z.boolean()}).strict();
const uuid=z.uuid().transform(value=>value.toLowerCase());
const creationBase={identityId:z.string().min(1).max(128),name:z.string().trim().min(1).max(120),
  instructions:z.string().max(4000),model:modelChoiceSchema,credentialId:z.union([z.literal('legacy'),uuid]).optional(),requestId:uuid};
const sourceCreation=z.object({...creationBase,sourceAgentId:uuid}).strict();
const deviceCreation=z.object({...creationBase,runnerId:uuid,profile:z.enum(['dsh-text','codex-code'])}).strict();
const unavailableSessionHash='0'.repeat(64);
export function agentRoute(request:Request){
  const path=new URL(request.url).pathname;
  return (request.method==='GET'&&(path==='/api/account/agent-models'||path==='/api/account/runner-credentials'||path==='/api/account/agents'||path==='/api/account/execution-settings'||grantPath.test(path)||projectAgentsPath.test(path)||localConfigPath.test(path)))||
    (request.method==='POST'&&(path==='/api/account/agent-settings'||path==='/api/account/agents'||agentPath.test(path)||grantPath.test(path)||path==='/api/account/execution-settings'))||
    (request.method==='DELETE'&&agentPath.test(path));
}
async function currentUser(client:PoolClient,principal:IdentityPrincipal){
  const user=(await client.query<{id:string;status:string}>('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR UPDATE',[principal.id])).rows[0];
  if(!user)throw 404;if(user.status!=='active')throw 403;return user;
}
async function ownedDevice(client:PoolClient,userId:string,runnerId:string,requireActive=true){
  const device=(await client.query<{id:string;revoked_at:Date|null}>('SELECT id,revoked_at FROM mas_business_runner_device WHERE id=$1 AND owner_id=$2 FOR UPDATE',[runnerId,userId])).rows[0];
  if(!device)throw 404;if(requireActive&&device.revoked_at)throw 403;return device;
}
async function ownedCredential(client:PoolClient,userId:string,runnerId:string,profile:string,credentialId:string){
  const row=(await client.query<{id:string}>(`SELECT id FROM mas_business_runner_credential
    WHERE runner_id=$1 AND owner_id=$2 AND profile=$3 AND id=$4`,[runnerId,userId,profile,credentialId])).rows[0];
  if(!row)throw 409;
}
async function ownedAgent(client:PoolClient,userId:string,agentId:string,enabled:boolean){
  const target=(await client.query<{runner_id:string}>('SELECT runner_id FROM mas_business_agent WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL',[agentId,userId])).rows[0];
  if(!target)throw 404;
  await ownedDevice(client,userId,target.runner_id,enabled);
  const agent=(await client.query<{id:string;version:number;enabled:boolean}>('SELECT id,version,enabled FROM mas_business_agent WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE',[agentId,userId])).rows[0];
  if(!agent)throw 404;return agent;
}
function needsChange(current:{version:number;value:unknown},expected:number,value:unknown){
  if(current.version===expected)return true;
  if(current.version===expected+1&&current.value===value)return false;
  throw 409;
}

export async function handleAgentRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  const path=new URL(request.url).pathname,grant=grantPath.exec(path),target=agentPath.exec(path);
  const projectAgents=projectAgentsPath.exec(path);
  const localConfig=localConfigPath.exec(path);
  if(localConfig&&request.method==='GET')return projectTransaction(pool,async client=>{
    const runnerId=uuid.parse(localConfig[1]);
    const row=(await client.query<{port:number|null;token:string|null}>(`SELECT d.local_config_port AS port,d.local_config_token AS token
      FROM mas_business_runner_device d JOIN mas_business_user u ON u.id=d.owner_id
      WHERE d.id=$1 AND u.identity_id=$2 AND u.status='active' AND d.revoked_at IS NULL
        AND d.session_until>clock_timestamp() AND d.local_config_seen>clock_timestamp()-interval '15 seconds'`,[runnerId,principal.id])).rows[0];
    return {identityId:principal.id,runnerId,available:!!row?.port&&!!row?.token,port:row?.port??null,token:row?.token??null};
  });
  if(path==='/api/account/runner-credentials'&&request.method==='GET')return projectTransaction(pool,async client=>{
    const user=(await client.query<{id:string;status:string}>('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR SHARE',[principal.id])).rows[0];
    if(user&&user.status!=='active')throw 403;
    const rows=await client.query(`SELECT c.runner_id AS "runnerId",c.id,c.profile,c.kind,c.label,
      (d.revoked_at IS NULL AND d.session_until>clock_timestamp() AND c.seen_at>clock_timestamp()-interval '15 seconds') AS ready
      FROM mas_business_runner_credential c JOIN mas_business_runner_device d ON d.id=c.runner_id
      WHERE c.owner_id=$1 ORDER BY d.name,c.profile,c.label,c.id`,[user?.id??null]);
    return {identityId:principal.id,credentials:rows.rows};
  });
  if(projectAgents&&request.method==='GET')return projectTransaction(pool,async client=>{
    const projectId=uuid.parse(projectAgents[1]),user=await authorizeProject(client,principal.id,projectId,false);
    const agents=await client.query(`SELECT a.id,a.name,a.profile,a.model,a.enabled,a.owner_id AS "ownerId",u.name AS "ownerName",
      g.enabled AS granted,g.version AS "grantVersion"
      FROM mas_business_agent_project g JOIN mas_business_agent a ON a.id=g.agent_id AND a.owner_id=g.owner_id AND a.deleted_at IS NULL
      JOIN mas_business_user u ON u.id=a.owner_id AND u.status='active'
      JOIN mas_business_project p ON p.id=g.project_id
      JOIN mas_business_membership om ON om.organization_id=p.organization_id AND om.user_id=a.owner_id AND om.status='active'
      JOIN mas_business_project_member pm ON pm.project_id=p.id AND pm.user_id=a.owner_id AND pm.status='active'
      WHERE g.project_id=$1 AND g.enabled AND ($3 OR a.owner_id=$2) ORDER BY a.created_at,a.id`,[projectId,user.id,['owner','manager'].includes(user.projectRole)]);
    return {identityId:principal.id,projectId,agents:agents.rows};
  });
  if(path==='/api/account/agent-settings'){
    const input=z.object({identityId:z.string().min(1).max(128),
      agents:z.array(z.object({id:uuid,expectedVersion:z.number().int().positive(),enabled:z.boolean(),model:modelIdSchema.nullable().optional(),credentialId:z.union([z.literal('legacy'),uuid]).optional(),routing:z.object({expectedVersion:z.number().int().positive(),difficultyMin:z.number().int().min(1).max(5),difficultyMax:z.number().int().min(1).max(5),preference:z.enum(['quality','balanced','economy']),relativeCost:z.number().int().min(1).max(3)}).strict().refine(v=>v.difficultyMin<=v.difficultyMax).optional()}).strict()).max(200),
      capacity:z.object({expectedVersion:z.number().int().min(0),maxConcurrency:z.number().int().min(1).max(8)}).strict().optional(),
    }).strict().refine(v=>(v.agents.length>0||!!v.capacity)&&new Set(v.agents.map(a=>a.id)).size===v.agents.length).parse(await readBoundedJson(request));
    if(input.identityId!==principal.id)throw 403;
    return projectTransaction(pool,async client=>{
      // Same owner lock as the individual endpoints; all settings commit together.
      if(!input.agents.length)await client.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3) ON CONFLICT(identity_id) DO NOTHING',[randomUUID(),principal.id,principal.name]);
      const user=await currentUser(client,principal);
      for(const item of [...input.agents].sort((a,b)=>a.id.localeCompare(b.id))){
        await ownedAgent(client,user.id,item.id,item.enabled||item.model!==undefined||item.credentialId!==undefined);
        const current=(await client.query<{version:number;model:string|null;enabled:boolean;runner_id:string;profile:string;credential_id:string;routing_version:number;difficulty_min:number;difficulty_max:number;routing_preference:string;relative_cost:number}>('SELECT version,model,enabled,runner_id,profile,credential_id,routing_version,difficulty_min,difficulty_max,routing_preference,relative_cost FROM mas_business_agent WHERE id=$1 FOR UPDATE',[item.id])).rows[0];
        const model=item.model===undefined?current.model:item.model;
        const credentialId=item.credentialId??current.credential_id;
        if(item.credentialId!==undefined){
          if(current.profile==='demo')throw 409;
          await ownedCredential(client,user.id,current.runner_id,current.profile,credentialId);
        }
        const routingChanged=item.routing&&needsChange({version:current.routing_version,value:JSON.stringify([current.difficulty_min,current.difficulty_max,current.routing_preference,current.relative_cost])},item.routing.expectedVersion,JSON.stringify([item.routing.difficultyMin,item.routing.difficultyMax,item.routing.preference,item.routing.relativeCost]));
        if(needsChange({version:current.version,value:JSON.stringify([current.model,current.enabled,current.credential_id])},item.expectedVersion,JSON.stringify([model,item.enabled,credentialId]))){
          if(item.model!==undefined)await validateModel(client,current.profile,model);
          if(item.model!==undefined&&model!==current.model){
            const defaults=item.routing??await catalogRoutingDefaults(client,current.profile,await routingModel(client,current.profile,model));
            await client.query('UPDATE mas_business_agent SET model=$2,enabled=$3,difficulty_min=$4,difficulty_max=$5,relative_cost=$6,routing_capabilities=NULL,version=version+1 WHERE id=$1',[item.id,model,item.enabled,defaults.difficultyMin,defaults.difficultyMax,defaults.relativeCost]);
          }else await client.query('UPDATE mas_business_agent SET model=$2,enabled=$3,version=version+1 WHERE id=$1',[item.id,model,item.enabled]);
          if(credentialId!==current.credential_id)await client.query('UPDATE mas_business_agent SET credential_id=$2,ready_until=to_timestamp(0) WHERE id=$1',[item.id,credentialId]);
        }
        if(item.routing&&routingChanged)await client.query(`UPDATE mas_business_agent SET difficulty_min=$2,difficulty_max=$3,routing_preference=$4,relative_cost=$5,routing_capabilities=NULL,routing_version=routing_version+1 WHERE id=$1`,[item.id,item.routing.difficultyMin,item.routing.difficultyMax,item.routing.preference,item.routing.relativeCost]);
      }
      if(input.capacity){
        const current=(await client.query<{version:number;value:number}>('SELECT version,max_concurrency AS value FROM mas_business_execution_policy WHERE user_id=$1 FOR UPDATE',[user.id])).rows[0]??{version:0,value:1};
        if(needsChange(current,input.capacity.expectedVersion,input.capacity.maxConcurrency))await client.query(`INSERT INTO mas_business_execution_policy(user_id,max_concurrency,version)
          VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET max_concurrency=excluded.max_concurrency,version=excluded.version`,[user.id,input.capacity.maxConcurrency,current.version+1]);
      }
      return {identityId:principal.id,saved:true};
    });
  }
  if(path==='/api/account/agent-models')return projectTransaction(pool,async client=>{
    const user=(await client.query<{id:string;status:string}>('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR SHARE',[principal.id])).rows[0];
    const directory=await client.query(`SELECT vendor,profile,model,display_name AS "displayName",difficulty_min AS "difficultyMin",difficulty_max AS "difficultyMax",relative_cost AS "relativeCost",is_default AS "isDefault"
      FROM mas_business_model_catalog WHERE enabled ORDER BY sort_order,vendor,model`);
    if(user&&user.status!=='active')throw 403;
    return {identityId:principal.id,models:modelDirectorySchema.parse(directory.rows)};
  });
  if(request.method==='GET'&&path!=='/api/account/execution-settings')return listAgents(pool,principal,grant?uuid.parse(grant[1]):undefined);
  if(request.method==='DELETE'&&target){
    const input=z.object({identityId:z.string().min(1).max(128)}).strict().parse(await readBoundedJson(request));
    if(input.identityId!==principal.id)throw 403;
    return projectTransaction(pool,async client=>{
      const user=await currentUser(client,principal),id=uuid.parse(target[1]);
      const agent=(await client.query<{deleted_at:Date|null}>(
        'SELECT deleted_at FROM mas_business_agent WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,user.id])).rows[0];
      if(!agent)throw 404;
      if(agent.deleted_at)return {identityId:principal.id,deleted:true};
      if((await client.query('SELECT 1 FROM mas_business_project_coordinator WHERE agent_id=$1 LIMIT 1',[id])).rowCount)throw 409;
      if((await client.query("SELECT 1 FROM mas_business_work_attempt WHERE agent_id=$1 AND state IN ('assigned','running') LIMIT 1",[id])).rowCount)throw 409;
      await client.query('UPDATE mas_business_agent SET deleted_at=clock_timestamp(),enabled=false,version=version+1 WHERE id=$1 AND owner_id=$2',[id,user.id]);
      await client.query('UPDATE mas_business_agent_project SET enabled=false,version=version+1 WHERE agent_id=$1 AND owner_id=$2 AND enabled',[id,user.id]);
      return {identityId:principal.id,deleted:true};
    });
  }
  if(path==='/api/account/agents'){
    const input=z.union([sourceCreation,deviceCreation]).parse(await readBoundedJson(request));
    if(input.identityId!==principal.id)throw 403;
    return projectTransaction(pool,async client=>{
      const user=await currentUser(client,principal);
      if('runnerId' in input)await ownedDevice(client,user.id,input.runnerId);
      else await ownedAgent(client,user.id,input.sourceAgentId,true);
      const receipt=(await client.query<{source_agent_id:string|null;runner_id:string|null;profile:string|null;agent_id:string;name:string;instructions:string;model:string|null;credential_id:string|null}>(
        'SELECT * FROM mas_business_agent_creation WHERE owner_id=$1 AND request_id=$2',[user.id,input.requestId])).rows[0];
      if(receipt){
        const sameTarget='runnerId' in input
          ?receipt.source_agent_id===null&&receipt.runner_id===input.runnerId&&receipt.profile===input.profile
          :receipt.source_agent_id===input.sourceAgentId&&receipt.runner_id===null&&receipt.profile===null;
        if(!sameTarget||receipt.name!==input.name||receipt.instructions!==input.instructions||receipt.model!==input.model||('credentialId' in input&&input.credentialId!==undefined&&receipt.credential_id!==input.credentialId))throw 409;
        return {identityId:principal.id,agentId:receipt.agent_id};
      }
      const agentId=randomUUID();
      const source='runnerId' in input?input:(await client.query<{runnerId:string;profile:string;credentialId:string|null}>('SELECT runner_id AS "runnerId",profile,credential_id AS "credentialId" FROM mas_business_agent WHERE id=$1',[input.sourceAgentId])).rows[0];
      const credentialId=source.profile==='demo'?'legacy':input.credentialId??source.credentialId??'legacy';
      if(source.profile!=='demo')await ownedCredential(client,user.id,source.runnerId,source.profile,credentialId);
      await validateModel(client,source.profile,input.model);
      const routingDefaults=await catalogRoutingDefaults(client,source.profile,await routingModel(client,source.profile,input.model));
      if('runnerId' in input){
        await client.query(`INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,ready_until,ready_session_hash,name,instructions,difficulty_min,difficulty_max,relative_cost,credential_id)
          VALUES($1,$2,$3,$4,to_timestamp(0),$5,$6,$7,$8,$9,$10,$11)`,
        [agentId,input.runnerId,user.id,input.profile,unavailableSessionHash,input.name,input.instructions,routingDefaults.difficultyMin,routingDefaults.difficultyMax,routingDefaults.relativeCost,credentialId]);
        await client.query(`INSERT INTO mas_business_agent_creation(owner_id,request_id,runner_id,profile,agent_id,name,instructions,credential_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[user.id,input.requestId,input.runnerId,input.profile,agentId,input.name,input.instructions,credentialId]);
      }else{
        await client.query(`INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,ready_until,ready_session_hash,name,instructions,difficulty_min,difficulty_max,relative_cost,credential_id)
          SELECT $1,runner_id,owner_id,profile,to_timestamp(0),ready_session_hash,$3,$4,$5,$6,$7,$8 FROM mas_business_agent WHERE id=$2`,
          [agentId,input.sourceAgentId,input.name,input.instructions,routingDefaults.difficultyMin,routingDefaults.difficultyMax,routingDefaults.relativeCost,credentialId]);
        await client.query('INSERT INTO mas_business_agent_creation(owner_id,request_id,source_agent_id,agent_id,name,instructions,credential_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [user.id,input.requestId,input.sourceAgentId,agentId,input.name,input.instructions,credentialId]);
      }
      await client.query('UPDATE mas_business_agent SET model=$2 WHERE id=$1',[agentId,input.model]);
      await client.query('UPDATE mas_business_agent_creation SET model=$3 WHERE owner_id=$1 AND request_id=$2',[user.id,input.requestId,input.model]);
      return {identityId:principal.id,agentId};
    });
  }
  if(path==='/api/account/execution-settings'){
    if(request.method==='GET')return projectTransaction(pool,async client=>{
      const user=(await client.query<{id:string;status:string}>('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR SHARE',[principal.id])).rows[0];
      if(user&&user.status!=='active')throw 403;
      const row=(await client.query('SELECT max_concurrency AS "maxConcurrency",version FROM mas_business_execution_policy WHERE user_id=$1',[user?.id??null])).rows[0];
      return {identityId:principal.id,settings:row??{maxConcurrency:1,version:0}};
    });
    const input=z.object({identityId:z.string().min(1).max(128),expectedVersion:z.number().int().min(0),maxConcurrency:z.number().int().min(1).max(8)}).strict().parse(await readBoundedJson(request));
    if(input.identityId!==principal.id)throw 403;
    return projectTransaction(pool,async client=>{
      await client.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3) ON CONFLICT(identity_id) DO NOTHING',[randomUUID(),principal.id,principal.name]);
      const user=await currentUser(client,principal);
      const current=(await client.query<{version:number;value:number}>('SELECT version,max_concurrency AS value FROM mas_business_execution_policy WHERE user_id=$1 FOR UPDATE',[user.id])).rows[0]??{version:0,value:1};
      if(needsChange(current,input.expectedVersion,input.maxConcurrency))await client.query(`INSERT INTO mas_business_execution_policy(user_id,max_concurrency,version)
        VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET max_concurrency=excluded.max_concurrency,version=excluded.version`,[user.id,input.maxConcurrency,current.version+1]);
      return {identityId:principal.id,version:input.expectedVersion+1};
    });
  }
  const raw=await readBoundedJson(request);
  if(target&&typeof raw==='object'&&raw!==null&&'credentialId' in raw){
    const input=z.object({identityId:z.string().min(1).max(128),expectedVersion:z.number().int().positive(),credentialId:z.union([z.literal('legacy'),uuid])}).strict().parse(raw);
    if(input.identityId!==principal.id)throw 403;
    return projectTransaction(pool,async client=>{
      const user=await currentUser(client,principal),id=uuid.parse(target[1]);
      await ownedAgent(client,user.id,id,true);
      const agent=(await client.query<{version:number;credential_id:string|null;runner_id:string;profile:string}>('SELECT version,credential_id,runner_id,profile FROM mas_business_agent WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(agent.profile==='demo')throw 409;
      await ownedCredential(client,user.id,agent.runner_id,agent.profile,input.credentialId);
      if(needsChange({version:agent.version,value:agent.credential_id},input.expectedVersion,input.credentialId))
        await client.query('UPDATE mas_business_agent SET credential_id=$2,ready_until=to_timestamp(0),version=version+1 WHERE id=$1',[id,input.credentialId]);
      return {identityId:principal.id,version:input.expectedVersion+1};
    });
  }
  if(target&&typeof raw==='object'&&raw!==null&&'model' in raw){
    const input=z.object({identityId:z.string().min(1).max(128),expectedVersion:z.number().int().positive(),model:modelChoiceSchema,enabled:z.boolean().optional()}).strict().parse(raw);
    if(input.identityId!==principal.id)throw 403;
    return projectTransaction(pool,async client=>{
      const user=await currentUser(client,principal),id=uuid.parse(target[1]);await ownedAgent(client,user.id,id,true);
      const agent=(await client.query<{version:number;model:string|null;runner_id:string;profile:string;enabled:boolean}>('SELECT version,model,runner_id,profile,enabled FROM mas_business_agent WHERE id=$1 FOR UPDATE',[id])).rows[0];
      // Compare the whole command for replay, not only its model half.
      const enabled=input.enabled??agent.enabled;
      if(needsChange({version:agent.version,value:JSON.stringify([agent.model,agent.enabled])},input.expectedVersion,JSON.stringify([input.model,enabled]))){
        await validateModel(client,agent.profile,input.model);
        const defaults=await catalogRoutingDefaults(client,agent.profile,await routingModel(client,agent.profile,input.model));
        await client.query('UPDATE mas_business_agent SET model=$2,enabled=$3,difficulty_min=$4,difficulty_max=$5,relative_cost=$6,routing_capabilities=NULL,version=version+1 WHERE id=$1',[id,input.model,enabled,defaults.difficultyMin,defaults.difficultyMax,defaults.relativeCost]);
      }
      return {identityId:principal.id,version:input.expectedVersion+1};
    });
  }
  const input=(grant?change.extend({agentId:uuid}).strict():change).parse(raw);
  if(input.identityId!==principal.id)throw 403;
  const projectId=grant?uuid.parse(grant[1]):null;
  const agentId=grant&&'agentId' in input?uuid.parse(input.agentId):uuid.parse(target?.[1]);
  return projectTransaction(pool,async client=>{
    const user=projectId?await authorizeProject(client,principal.id,projectId,true):await currentUser(client,principal);
    const agent=await ownedAgent(client,user.id,agentId,input.enabled);
    if(projectId){
      const current=(await client.query<{version:number;value:boolean}>(`SELECT version,enabled AS value FROM mas_business_agent_project
        WHERE agent_id=$1 AND project_id=$2 FOR UPDATE`,[agentId,projectId])).rows[0]??{version:0,value:false};
      if(needsChange(current,input.expectedVersion,input.enabled))await client.query(`INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled,version)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(agent_id,project_id) DO UPDATE SET enabled=excluded.enabled,version=excluded.version`,
      [agentId,user.id,projectId,input.enabled,current.version+1]);
    }else if(needsChange({version:agent.version,value:agent.enabled},input.expectedVersion,input.enabled)){
      await client.query('UPDATE mas_business_agent SET enabled=$2,version=version+1 WHERE id=$1',[agentId,input.enabled]);
    }
    return {identityId:principal.id,version:input.expectedVersion+1};
  });
}

async function validateModel(client:PoolClient,profile:string,model:string|null){
  if(model===null)return;
  const directory=(await client.query('SELECT difficulty_min FROM mas_business_model_catalog WHERE profile=$1 AND model=$2 AND enabled',[profile,model])).rows[0];
  if(!directory)throw 400;
}
async function catalogRoutingDefaults(client:PoolClient,profile:string,model:string|null){
  if(!model)return modelRoutingDefaults(model);
  const row=(await client.query<{difficultyMin:number;difficultyMax:number;relativeCost:number}>(`SELECT difficulty_min AS "difficultyMin",difficulty_max AS "difficultyMax",relative_cost AS "relativeCost"
    FROM mas_business_model_catalog WHERE profile=$1 AND model=$2 AND enabled`,[profile,model])).rows[0];
  return row?{difficultyMin:row.difficultyMin as 1,difficultyMax:row.difficultyMax as 1|2|3|4|5,relativeCost:row.relativeCost as 1|2|3}:modelRoutingDefaults(model);
}
async function routingModel(client:PoolClient,profile:string,model:string|null){
  if(model)return model;
  return (await client.query<{model:string}>(`SELECT model FROM mas_business_model_catalog
    WHERE profile=$1 AND enabled AND is_default ORDER BY sort_order,model LIMIT 1`,[profile])).rows[0]?.model??null;
}
