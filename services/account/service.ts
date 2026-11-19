import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityService,IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {handleProjectCommand,type ProjectCommand} from './projects.ts';
import {handleMemberRequest,memberRoute} from './member-routes.ts';
import {handleStoryRequest,storyRoute} from './story-routes.ts';
import {handlePublicationRequest,publicationRoute} from './task-publication-routes.ts';
import {deviceRoute,handleDeviceRequest} from './devices.ts';
import {handleRunnerConnection,authorizeRunnerSession,runnerCredential,runnerSessionSchema} from './runner-connections.ts';
import {projectTransaction} from './project-scope.ts';
import {announceAgent,agentRoute,handleAgentRequest} from './agents.ts';
import type {RunnerProfile} from '../../packages/domain/runner-protocol.ts';
import {coordinatorRoute,handleCoordinatorRequest} from './coordinator.ts';
import {executionRoute,handleTaskReview,handleExecutionRequest} from './execution-routes.ts';
import {offerWork} from './execution-store.ts';
import {recoveryRoute,handleExecutionRecovery} from './execution-recovery.ts';
import {deviceLaunchRoute,handleDeviceLaunch,handleDeviceLaunchAttach} from './device-launch.ts';
import type {ArtifactStorage} from './artifact-store.ts';
import {codeResultArtifactRoute,handleCodeResultArtifactRequest} from './code-result-artifacts.ts';
import {repositoryRoute,handleRepositoryRequest} from './code-repositories.ts';
import {repositoryBoundOffer} from './repository-dispatch.ts';
import {boardRoute,handleBoardRequest} from './board-routes.ts';
import {agentRoutingRoute,handleAgentRoutingRequest} from './agent-routing-routes.ts';
import {taskReworkRoute,handleTaskRework} from './task-rework.ts';
import {taskRetryRoute,handleTaskRetry} from './task-retry.ts';
import {storyAssistanceRoute,handleStoryAssistanceRequest} from './story-assistance.ts';
import {offerStoryWork} from './story-assistance-runner.ts';
import {organizationRoute,handleOrganizationRequest} from './organization-routes.ts';
import {taskActivityRoute,handleTaskActivity} from './task-activity.ts';
import {inviteLinkRoute,handleInviteLinkRequest} from './invite-links.ts';
import {bodyImageRoute,handleBodyImageRequest} from './body-images.ts';
import {directTaskRoute,handleDirectTaskRequest} from './direct-tasks.ts';
import {profileRoute,handleProfileRequest} from './profile.ts';
import {projectFilesRoute,handleProjectFiles,handleProjectSetupRunner} from './project-files.ts';
import {directoryPickWebRoute,directoryPickRunnerRoute,handleDirectoryPickWeb,handleDirectoryPickRunner} from './directory-pick.ts';
import {projectSecrets} from './project-secrets.ts';

const createSchema=z.object({name:z.string().trim().min(1).max(120),requestId:z.uuid()}).strict();
const organizationCreateSchema=z.object({name:z.string().trim().toLowerCase().min(1).max(50).regex(/^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$/),alias:z.string().trim().min(1).max(50),description:z.string().trim().max(200).default(''),requestId:z.uuid()}).strict();
const projectCreateSchema=z.union([createSchema.extend({key:z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),description:z.string().trim().max(200).default('')}).strict(),createSchema]);
function json(status:number,body:unknown,identityId?:string){
  return Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(identityId?{'X-MAS-Identity':identityId}:{})}});
}
function failure(status:number){return json(status,{error:{code:status===503?'account_unavailable':status===409?'idempotency_conflict':'account_denied'}});}

/** Identity authenticates; this product store grants only explicitly created
 * organization membership. The host owns the pool; runtime never executes DDL. */
export function createAccountService({pool,identity,origin,runnerProfiles=[],executeTasks=false,repositoryStore,storyAssistance=false,projectConfigSecret}:{pool:Pool;identity:IdentityService;origin:string;runnerProfiles?:readonly RunnerProfile[];executeTasks?:boolean;repositoryStore?:ArtifactStorage;storyAssistance?:boolean;projectConfigSecret?:string}){
  if(executeTasks&&!runnerProfiles.length)throw Error('Execution requires explicit Runner profiles');
  const fileSecrets=projectConfigSecret?projectSecrets(projectConfigSecret):undefined;
  const eligibleOffer:typeof offerWork=async(client,context,agentId,profile,bindings)=>{
    // Existing reservations always win, including when new admission is closed.
    // The stored target, not a client-supplied kind, chooses the recovery path.
    const active=(await client.query(`SELECT a.id,g.profile,to_jsonb(a)->>'story_job_id' AS story_job_id
      FROM mas_business_work_attempt a JOIN mas_business_agent g ON g.id=a.agent_id
      WHERE a.runner_id=$1 AND a.owner_id=$2 AND a.state IN ('assigned','running') ORDER BY a.created_at,a.id LIMIT 1`,[context.device.id,context.user.id])).rows[0];
    if(active){
      if(active.profile!==profile)return null;
      return active.story_job_id?offerStoryWork(client,context,agentId,profile,bindings):offerWork(client,context,agentId,profile,bindings,repositoryStore);
    }
    if(fileSecrets&&(await client.query("SELECT 1 FROM mas_business_project_setup WHERE runner_id=$1 AND state IN ('queued','running') LIMIT 1",[context.device.id])).rowCount)return null;
    if(storyAssistance){const offered=await offerStoryWork(client,context,agentId,profile,bindings);if(offered)return offered;}
    return offerWork(client,context,agentId,profile,bindings,repositoryStore);
  };
  const taskOffer=executeTasks?(repositoryStore?repositoryBoundOffer(eligibleOffer):eligibleOffer):undefined;
  const url=new URL(origin);
  if(url.origin!==origin || (url.protocol!=='https:' && !(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port)) ||
    (process.env.NODE_ENV==='production'&&url.protocol!=='https:'))throw Error('Account service requires an exact secure origin');

  async function current(principal:IdentityPrincipal){
    // Older organization rows may have been created before the explicit
    // membership insert existed. Restore only the creator's missing row; a
    // suspended membership is intentionally left untouched.
    await pool.query(`INSERT INTO mas_business_membership(organization_id,user_id,role)
      SELECT o.id,u.id,'owner' FROM mas_business_organization o JOIN mas_business_user u ON u.id=o.created_by
      WHERE u.identity_id=$1 AND u.status='active' ON CONFLICT(organization_id,user_id) DO NOTHING`,[principal.id]);
    // One snapshot: user suspension and membership listing are not separate reads.
    const result=await pool.query(`SELECT u.id,u.name,u.status,
      COALESCE(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'role',m.role,'slug',to_jsonb(o)->>'slug','alias',to_jsonb(o)->>'alias','description',to_jsonb(o)->>'description','version',coalesce((to_jsonb(o)->>'version')::integer,1),
        'image',CASE WHEN to_jsonb(o)->>'avatar' IS NULL THEN NULL ELSE '/api/account/organizations/'||o.id||'/avatar/'||coalesce((to_jsonb(o)->>'version')::integer,1) END) ORDER BY o.created_at,o.id)
        FILTER (WHERE o.id IS NOT NULL),'[]'::jsonb) AS organizations
      FROM mas_business_user u
      LEFT JOIN mas_business_membership m ON m.user_id=u.id AND m.status='active'
      LEFT JOIN mas_business_organization o ON o.id=m.organization_id
      WHERE u.identity_id=$1 GROUP BY u.id`,[principal.id]);
    const user=result.rows[0];
    if(!user)return json(200,{user:null,organizations:[]},principal.id);
    if(user.status!=='active')return failure(403);
    return json(200,{user:{id:user.id,name:user.name},organizations:user.organizations},principal.id);
  }

  async function create(principal:IdentityPrincipal,input:z.infer<typeof organizationCreateSchema>){
    const client=await pool.connect();
    try {
      await client.query('BEGIN');
      // The unique immutable identity binding serializes simultaneous first use.
      await client.query(`INSERT INTO mas_business_user (id,identity_id,name) VALUES ($1,$2,$3)
        ON CONFLICT (identity_id) DO NOTHING`,[randomUUID(),principal.id,principal.name]);
      const user=(await client.query('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR UPDATE',[principal.id])).rows[0];
      if(!user||user.status!=='active')throw 403;
      const hash=createHash('sha256').update(JSON.stringify({name:input.name,alias:input.alias,description:input.description})).digest('hex');
      const previous=(await client.query(`SELECT c.request_hash,o.id,o.name,to_jsonb(o)->>'slug' AS slug,to_jsonb(o)->>'alias' AS alias,to_jsonb(o)->>'description' AS description
        FROM mas_business_onboarding_command c JOIN mas_business_organization o ON o.id=c.organization_id
        WHERE c.user_id=$1 AND c.request_id=$2`,[user.id,input.requestId])).rows[0];
      let organization:{id:string;name:string;role:string;slug:string|null;alias:string|null;description:string|null};
      if(previous){
        // Wait behind in-flight revocation and retain authorization through commit.
        const membership=(await client.query(`SELECT role,status FROM mas_business_membership
          WHERE organization_id=$1 AND user_id=$2 FOR SHARE`,[previous.id,user.id])).rows[0];
        if(membership?.status!=='active')throw 403;
        if(previous.request_hash!==hash)throw 409;
        organization={id:previous.id,name:previous.name,role:membership.role,slug:previous.slug,alias:previous.alias,description:previous.description};
      }else{
        const id=randomUUID();
        await client.query('INSERT INTO mas_business_organization (id,name,created_by) VALUES ($1,$2,$3)',[id,input.name,user.id]);
        await client.query('UPDATE mas_business_organization SET slug=$2,alias=$3,description=$4,name=$5 WHERE id=$1',[id,input.name,input.alias,input.description,input.alias]);
        await client.query("INSERT INTO mas_business_membership (organization_id,user_id,role) VALUES ($1,$2,'owner')",[id,user.id]);
        await client.query('INSERT INTO mas_business_onboarding_command (user_id,request_id,request_hash,organization_id) VALUES ($1,$2,$3,$4)',[user.id,input.requestId,hash,id]);
        organization={id,name:input.alias,role:'owner',slug:input.name,alias:input.alias,description:input.description};
      }
      const metadataVersion=(await client.query("SELECT coalesce((to_jsonb(o)->>'version')::integer,1) AS version FROM mas_business_organization o WHERE id=$1",[organization.id])).rows[0].version;
      await client.query('COMMIT');return json(200,{organization:{...organization,version:metadataVersion,image:null}});
    }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
    finally{client.release();}
  }

  async function handle(request:Request):Promise<Response>{
    try {
      const target=new URL(request.url);
      if(target.origin!==origin||request.headers.get('sec-fetch-site')==='cross-site')return failure(403);
      if(target.search||target.hash)return failure(400);
      if(profileRoute(request)){
        if(request.method==='POST'&&request.headers.get('origin')!==origin)return failure(403);
        const principal=await identity.principal(request.headers);
        if(!principal)return failure(401);
        return await handleProfileRequest(pool,principal,request);
      }
      if(target.pathname==='/api/runner/capabilities'&&request.method==='POST'){
        const credential=runnerCredential(request),session=runnerSessionSchema.parse(await readBoundedJson(request,8192));
        return json(200,await projectTransaction(pool,async client=>{
          await authorizeRunnerSession(client,session,credential);
          return {codeArtifacts:repositoryStore?'private-v1':'disabled'};
        }));
      }
      if(codeResultArtifactRoute(request)){
        if(!repositoryStore||!executeTasks||!runnerProfiles.some(profile=>profile==='codex-code'||profile==='dsh-text'))return failure(404);
        return json(200,await handleCodeResultArtifactRequest(pool,repositoryStore,request));
      }
      if(repositoryRoute(request)){
        if(!repositoryStore)return failure(404);
        return json(200,await handleRepositoryRequest(pool,repositoryStore,request));
      }
      if(target.pathname==='/api/runner/tasks/poll'&&runnerProfiles.length)return json(200,await announceAgent(pool,request,runnerProfiles,taskOffer));
      if(target.pathname.startsWith('/api/runner/tasks/')&&executeTasks)return json(200,await handleExecutionRequest(pool,request,runnerProfiles,repositoryStore));
      if(target.pathname==='/api/runner/launch/attach')return json(200,await handleDeviceLaunchAttach(pool,request));
      if(directoryPickRunnerRoute(request)){
        if(!fileSecrets)return failure(404);
        return json(200,await handleDirectoryPickRunner(pool,request,fileSecrets));
      }
      if(target.pathname.startsWith('/api/runner/project-setup/')){
        if(!fileSecrets)return failure(404);
        return json(200,await handleProjectSetupRunner(pool,request,fileSecrets));
      }
      if(target.pathname.startsWith('/api/runner/'))return json(200,await handleRunnerConnection(pool,request));
      if(directoryPickWebRoute(request)){
        if(request.method==='POST'&&request.headers.get('origin')!==origin)return failure(403);
        const principal=await identity.principal(request.headers);
        if(!principal)return failure(401);
        if(!fileSecrets)return failure(503);
        return json(200,await handleDirectoryPickWeb(pool,principal,request,fileSecrets),principal.id);
      }
      if(projectFilesRoute(request)){
        if(request.method==='POST'&&request.headers.get('origin')!==origin)return failure(403);
        const principal=await identity.principal(request.headers);
        if(!principal)return failure(401);
        if(!fileSecrets)return failure(503);
        return json(200,await handleProjectFiles(pool,principal,request,fileSecrets),principal.id);
      }
      const organizationProjects=/^\/api\/account\/organizations\/([^/]+)\/projects$/.exec(target.pathname);
      const projectDetail=/^\/api\/account\/projects\/([^/]+)$/.exec(target.pathname);
      const read=target.pathname==='/api/account/me'&&request.method==='GET';
      const devices=deviceRoute(request);
      const agents=agentRoute(request);
      const coordinator=coordinatorRoute(request);
      const recovery=recoveryRoute(request);
      const execution=executionRoute(request)||recovery;
      const launch=deviceLaunchRoute(request);
      const write=target.pathname==='/api/account/organizations'&&request.method==='POST';
      const projectRead=!!(organizationProjects||projectDetail)&&request.method==='GET';
      const projectWrite=!!organizationProjects&&request.method==='POST';
      const link=inviteLinkRoute(request),member=memberRoute(request)||link;
      const organization=organizationRoute(request),activity=taskActivityRoute(request);
      const story=storyRoute(request);
      const publication=publicationRoute(request);
      const board=boardRoute(request);
      const routing=agentRoutingRoute(request),rework=taskReworkRoute(request),retry=taskRetryRoute(request),assistance=storyAssistanceRoute(request);
      const bodyImage=bodyImageRoute(request),directTask=directTaskRoute(request);
      if(!read&&!write&&!projectRead&&!projectWrite&&!member&&!organization&&!activity&&!story&&!publication&&!devices&&!agents&&!coordinator&&!execution&&!launch&&!board&&!routing&&!rework&&!retry&&!assistance&&!bodyImage&&!directTask)return failure(404);
      if((write||projectWrite||((member||organization||activity||story||publication||devices||agents||coordinator||execution||launch||board||routing||rework||retry||assistance||bodyImage||directTask)&&request.method==='POST')||(agents&&request.method==='DELETE'))&&request.headers.get('origin')!==origin)return failure(403);
      const principal=await identity.principal(request.headers);
      if(!principal)return failure(401);
      if(bodyImage)return await handleBodyImageRequest(pool,principal,request);
      if(directTask)return json(200,await handleDirectTaskRequest(pool,principal,request));
      if(link)return json(200,await handleInviteLinkRequest(pool,principal,request));
      if(activity)return json(200,await handleTaskActivity(pool,principal,request));
      if(organization){const result=await handleOrganizationRequest(pool,principal,request);return result instanceof Response?result:json(200,result);}
      if(assistance)return storyAssistance?json(200,await handleStoryAssistanceRequest(pool,principal,request)):failure(503);
      if(rework)return json(200,await handleTaskRework(pool,principal,request));
      if(retry)return json(200,await handleTaskRetry(pool,principal,request));
      if(routing)return json(200,await handleAgentRoutingRequest(pool,principal,request));
      if(board)return json(200,await handleBoardRequest(pool,principal,request));
      if(launch)return json(200,await handleDeviceLaunch(pool,principal,request));
      if(execution)return json(200,recovery?await handleExecutionRecovery(pool,principal,request):await handleTaskReview(pool,principal,request));
      if(coordinator)return json(200,await handleCoordinatorRequest(pool,principal,request));
      if(agents)return json(200,await handleAgentRequest(pool,principal,request),principal.id);
      if(devices)return json(200,await handleDeviceRequest(pool,principal,request));
      if(publication)return json(200,await handlePublicationRequest(pool,principal,request));
      if(story)return json(200,await handleStoryRequest(pool,principal,request));
      if(member)return json(200,await handleMemberRequest(pool,principal,request));
      if(projectRead||projectWrite){
        let command:ProjectCommand;
        if(projectDetail)command={kind:'detail',projectId:z.uuid().parse(projectDetail[1])};
        else{
          const organizationId=z.uuid().parse(organizationProjects![1]);
          command=projectWrite?{kind:'create',organizationId,...projectCreateSchema.parse(await readBoundedJson(request))}
            :{kind:'list',organizationId};
        }
        return json(200,await handleProjectCommand(pool,principal.id,command),principal.id);
      }
      return read?await current(principal):await create(principal,organizationCreateSchema.parse(await readBoundedJson(request)));
    }catch(e){return failure([400,403,404,409,413,428,429].includes(e as number)?e as number:e instanceof z.ZodError?400:(e as {code?:string})?.code==='23505'?409:503);}
  }
  return {handle};
}
