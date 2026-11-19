import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {runnerProfileSchema,remoteResultSchema,type RunnerProfile} from '../../packages/domain/runner-protocol.ts';
import {runnerCredential,runnerSessionSchema,authorizeRunnerSession} from './runner-connections.ts';
import {projectTransaction,authorizeProject,authorizeProjectContent} from './project-scope.ts';
import {startWork,renewWork,finishWork,stopWork,recordWorkProgress,takeWorkMessage,acknowledgeWorkMessage} from './execution-store.ts';
import {conversationSnapshotSchema,CONVERSATION_MAX_BYTES,taskMessageInputSchema} from '../../packages/domain/task-conversation.ts';
import {readTaskConversation} from './task-conversation.ts';
import {enqueueTaskMessage} from './task-messages.ts';
import {executionFailureReasonSchema} from '../../packages/domain/execution-errors.ts';
import type {ArtifactStorage} from './artifact-store.ts';
import {storyAttemptId,startStoryWork,renewStoryWork,finishStoryWork,stopStoryWork} from './story-assistance-runner.ts';

const ref=z.object({taskId:z.uuid(),attemptId:z.uuid(),fence:z.number().int().positive().max(16)}).strict();
const base=runnerSessionSchema.extend({ref}).strict();
export async function handleExecutionRequest(pool:Pool,request:Request,profiles:readonly RunnerProfile[],artifacts?:ArtifactStorage){
  const action=/^\/api\/runner\/tasks\/(start|renew|finish|stopped|progress|messages|message-ack)$/.exec(new URL(request.url).pathname)?.[1];
  if(request.method!=='POST'||!action)throw 404;
  const credential=runnerCredential(request);
  const schema=action==='start'?base.extend({profile:runnerProfileSchema}).strict():action==='finish'?base.extend({result:remoteResultSchema}).strict():action==='progress'?base.extend({snapshot:conversationSnapshotSchema}).strict():action==='message-ack'?base.extend({messageId:z.uuid(),outcome:z.enum(['delivered','rejected','unknown'])}).strict():action==='stopped'?base.extend({reason:executionFailureReasonSchema.optional()}).strict():base;
  const input=schema.parse(await readBoundedJson(request,action==='finish'?98_304:action==='progress'?CONVERSATION_MAX_BYTES+2048:8192));
  return projectTransaction(pool,async client=>{
    const context=await authorizeRunnerSession(client,input,credential);
    const agent=(await client.query<{profile:RunnerProfile}>(`SELECT g.profile FROM mas_business_work_attempt a
      JOIN mas_business_agent g ON g.id=a.agent_id WHERE a.id=$1 AND a.owner_id=$2 AND a.runner_id=$3`,[input.ref.attemptId,context.user.id,context.device.id])).rows[0];
    if(!agent)throw 409;if(!profiles.includes(agent.profile))throw 503;
    if(await storyAttemptId(client,input.ref.attemptId)){
      if(['progress','messages','message-ack'].includes(action))throw 409;
      if(action==='start'&&'profile' in input)return startStoryWork(client,context,input.ref,runnerProfileSchema.parse(input.profile));
      if(action==='finish'&&'result' in input)return finishStoryWork(client,context,input.ref,remoteResultSchema.parse(input.result));
      return action==='renew'?renewStoryWork(client,context,input.ref):stopStoryWork(client,context,input.ref,'reason' in input?executionFailureReasonSchema.optional().parse(input.reason):undefined);
    }
    if(action==='start'&&'profile' in input)return startWork(client,context,input.ref,runnerProfileSchema.parse(input.profile));
    if(action==='finish'&&'result' in input)return finishWork(client,context,input.ref,remoteResultSchema.parse(input.result),artifacts);
    if(action==='progress'&&'snapshot' in input)return recordWorkProgress(client,context,input.ref,conversationSnapshotSchema.parse(input.snapshot));
    if(action==='messages')return takeWorkMessage(client,context,input.ref);
    if(action==='message-ack'&&'messageId' in input&&'outcome' in input)return acknowledgeWorkMessage(client,context,input.ref,z.uuid().parse(input.messageId),z.enum(['delivered','rejected','unknown']).parse(input.outcome));
    return action==='renew'?renewWork(client,context,input.ref):stopWork(client,context,input.ref,'reason' in input?executionFailureReasonSchema.optional().parse(input.reason):undefined);
  });
}

const reviewPath=/^\/api\/account\/projects\/([^/]+)\/tasks\/([^/]+)\/(review|assessment-approval)$/;
const listPath=/^\/api\/account\/projects\/([^/]+)\/tasks(?:\/before\/([^/]+))?$/;
const focusedPath=/^\/api\/account\/projects\/([^/]+)\/boards\/([^/]+)\/tasks\/([^/]+)$/;
const conversationPath=/^\/api\/account\/projects\/([^/]+)\/tasks\/([^/]+)\/conversation$/;
const messagesPath=/^\/api\/account\/projects\/([^/]+)\/tasks\/([^/]+)\/conversation\/messages$/;
export function executionRoute(request:Request){const path=new URL(request.url).pathname;return (request.method==='POST'&&(reviewPath.test(path)||messagesPath.test(path)))||(request.method==='GET'&&(listPath.test(path)||focusedPath.test(path)||conversationPath.test(path)||messagesPath.test(path)));}
export async function handleTaskReview(pool:Pool,principal:IdentityPrincipal,request:Request){
  const messages=messagesPath.exec(new URL(request.url).pathname);
  if(messages){
    const projectId=z.uuid().parse(messages[1]),taskId=z.uuid().parse(messages[2]);
    return request.method==='GET'?readTaskConversation(pool,principal,projectId,taskId,true):enqueueTaskMessage(pool,principal,projectId,taskId,taskMessageInputSchema.parse(await readBoundedJson(request)));
  }
  if(request.method==='GET'){
    const conversation=conversationPath.exec(new URL(request.url).pathname);
    if(conversation)return readTaskConversation(pool,principal,z.uuid().parse(conversation[1]),z.uuid().parse(conversation[2]));
    const focused=focusedPath.exec(new URL(request.url).pathname);
    if(focused)return listTasks(pool,principal,z.uuid().parse(focused[1]),null,request.headers.get('X-MAS-Task-Presentation')==='1',{boardId:z.uuid().parse(focused[2]),taskId:z.uuid().parse(focused[3])});
    const match=listPath.exec(new URL(request.url).pathname)!;
    return listTasks(pool,principal,z.uuid().parse(match[1]),match[2]?z.uuid().parse(match[2]):null,request.headers.get('X-MAS-Task-Presentation')==='1');
  }
  const path=reviewPath.exec(new URL(request.url).pathname)!;
  const projectId=z.uuid().parse(path[1]),taskId=z.uuid().parse(path[2]);
  if(path[3]==='assessment-approval')return approveAssessment(pool,principal,request,projectId,taskId);
  const input=z.object({identityId:z.string().min(1).max(128),attemptId:z.uuid(),decision:z.enum(['accept','reject']),feedback:z.string().trim().min(1).max(2000)}).strict().parse(await readBoundedJson(request));
  if(input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,principal.id,projectId,true);
    if(!['owner','manager'].includes(user.projectRole))throw 403;
    const work=(await client.query(`SELECT w.* FROM mas_business_work w JOIN mas_business_task t ON t.id=w.task_id
      WHERE w.task_id=$1 AND t.project_id=$2 AND w.kind='execute' FOR UPDATE OF w`,[taskId,projectId])).rows[0];
    if(!work)throw 404;
    const attempt=(await client.query('SELECT state,fence FROM mas_business_work_attempt WHERE id=$1 AND work_id=$2',[input.attemptId,work.id])).rows[0];
    if(!attempt||attempt.state!=='finished'||attempt.fence!==work.calls)throw 409;
    const receipt=(await client.query('SELECT actor_id,decision,feedback FROM mas_business_work_review WHERE attempt_id=$1',[input.attemptId])).rows[0];
    if(receipt){if(receipt.actor_id!==user.id||receipt.decision!==input.decision||receipt.feedback!==input.feedback)throw 409;return {identityId:principal.id,ok:true};}
    if(work.state!=='review')throw 409;
    await client.query('INSERT INTO mas_business_work_review(attempt_id,actor_id,decision,feedback) VALUES($1,$2,$3,$4)',[input.attemptId,user.id,input.decision,input.feedback]);
    const state=input.decision==='accept'?'done':'failed';
    await client.query('UPDATE mas_business_work SET state=$2 WHERE id=$1',[work.id,state]);
    await client.query('UPDATE mas_business_task SET status=$2 WHERE id=$1',[taskId,state]);
    return {identityId:principal.id,ok:true};
  });
}

async function approveAssessment(pool:Pool,principal:IdentityPrincipal,request:Request,projectId:string,taskId:string){
  const input=z.object({identityId:z.string().min(1).max(128),attemptId:z.uuid()}).strict().parse(await readBoundedJson(request));
  if(input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,principal.id,projectId,true);
    if((await client.query('SELECT owner_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0].owner_id!==user.id)throw 403;
    const work=(await client.query(`SELECT w.id,w.state,w.calls FROM mas_business_work w JOIN mas_business_task t ON t.id=w.task_id
      WHERE w.task_id=$1 AND t.project_id=$2 AND w.kind='assess' FOR UPDATE OF w`,[taskId,projectId])).rows[0];
    if(!work)throw 404;
    const attempt=(await client.query('SELECT fence,state FROM mas_business_work_attempt WHERE id=$1 AND work_id=$2',[input.attemptId,work.id])).rows[0];
    if(work.state!=='done'||!attempt||attempt.state!=='finished'||attempt.fence!==work.calls)throw 409;
    await client.query('INSERT INTO mas_business_assessment_approval(attempt_id,actor_id) VALUES($1,$2) ON CONFLICT(attempt_id) DO NOTHING',[input.attemptId,user.id]);
    await client.query('UPDATE mas_business_work SET approved=true WHERE id=$1',[work.id]);
    await client.query("INSERT INTO mas_business_work(id,task_id,kind) VALUES($1,$2,'execute') ON CONFLICT(task_id,kind) DO NOTHING",[randomUUID(),taskId]);
    return {identityId:principal.id,ok:true};
  });
}

async function listTasks(pool:Pool,principal:IdentityPrincipal,projectId:string,cursor:string|null,presentation=false,focus?:{boardId:string;taskId:string}){
  return projectTransaction(pool,async client=>{
    await authorizeProjectContent(client,principal.id,projectId);
    if(cursor&&!(await client.query('SELECT 1 FROM mas_business_task WHERE id=$1 AND project_id=$2',[cursor,projectId])).rowCount)throw 404;
    const tasks=await client.query(`SELECT t.id,t.board_id AS "boardId",t.title,t.objective,t.acceptance_criteria AS "acceptanceCriteria",
      t.required_capabilities AS "requiredCapabilities",t.status,
      CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('state',a.state,'calls',a.calls-coalesce((to_jsonb(a)->>'round_start_calls')::integer,0),'approved',a.approved,
        'result',a.result,'issues',a.issues,'attemptId',aa.id) END AS assessment,
      CASE WHEN e.id IS NULL THEN NULL ELSE jsonb_build_object('state',e.state,'attemptId',ea.id,
        'summary',e.result->'summary','artifacts',coalesce(e.result->'artifacts','[]'::jsonb),'issues',e.issues) END AS execution
      FROM mas_business_task t JOIN mas_business_task_publication p ON p.id=t.publication_id
      LEFT JOIN mas_business_work a ON a.task_id=t.id AND a.kind='assess'
      LEFT JOIN mas_business_work_attempt aa ON aa.work_id=a.id AND aa.fence=a.calls
      LEFT JOIN mas_business_work e ON e.task_id=t.id AND e.kind='execute'
      LEFT JOIN mas_business_work_attempt ea ON ea.work_id=e.id AND ea.fence=e.calls
      LEFT JOIN mas_business_task cursor_task ON cursor_task.id=$2::uuid AND cursor_task.project_id=$1
      LEFT JOIN mas_business_task_publication cursor_publication ON cursor_publication.id=cursor_task.publication_id
      WHERE t.project_id=$1 AND ($3::uuid IS NULL OR (t.id=$3 AND t.board_id=$4 AND EXISTS(
        SELECT 1 FROM mas_business_board b WHERE b.id=$4 AND b.project_id=$1 AND to_jsonb(b)->>'archived_at' IS NULL)))
      AND ($2::uuid IS NULL OR (p.created_at,p.id)<(cursor_publication.created_at,cursor_publication.id)
        OR (p.id=cursor_publication.id AND t.position>cursor_task.position))
      ORDER BY p.created_at DESC,p.id DESC,t.position LIMIT 51`,[projectId,cursor,focus?.taskId??null,focus?.boardId??null]);
    const page=tasks.rows.slice(0,50);
    if(focus&&page.length!==1)throw 404;
    type Presentation={id:string;priority:'low'|'normal'|'high';dependencyCount:number;responsibleName:string|null;agentName:string|null;profile:RunnerProfile|null;recoveryRequired:boolean};
    const metadata=presentation&&page.length?await client.query<Presentation>(`SELECT t.id,t.priority,
      (SELECT count(*)::int FROM mas_business_task_dependency d WHERE d.task_id=t.id) AS "dependencyCount",
      u.name AS "responsibleName",g.name AS "agentName",g.profile,
      EXISTS(SELECT 1 FROM mas_business_work w JOIN mas_business_work_attempt a ON a.work_id=w.id
        JOIN mas_business_runner_device d ON d.id=a.runner_id WHERE w.task_id=t.id AND a.state IN ('assigned','running')
        AND (d.revoked_at IS NOT NULL OR a.lease_until<=clock_timestamp() OR d.session_until IS NULL OR d.session_until<=clock_timestamp())) AS "recoveryRequired"
      FROM mas_business_task t
      LEFT JOIN mas_business_work e ON e.task_id=t.id AND e.kind='execute'
      LEFT JOIN mas_business_work_attempt ea ON ea.work_id=e.id AND ea.fence=e.calls
        AND ea.fence>coalesce((to_jsonb(e)->>'round_start_calls')::integer,0)
      LEFT JOIN mas_business_agent g ON g.id=ea.agent_id AND g.owner_id=ea.owner_id
      LEFT JOIN mas_business_user u ON u.id=ea.owner_id
      WHERE t.project_id=$1 AND t.id=ANY($2::uuid[])`,[projectId,page.map(t=>t.id)]):null;
    const byId=new Map(metadata?.rows.map(({id,...value})=>[id,value]));
    return {identityId:principal.id,projectId,tasks:presentation?page.map(task=>{
      const value=byId.get(task.id);if(!value)throw Error('Task presentation missing');
      return {...task,presentation:value};
    }):page,hasMore:tasks.rows.length>50,nextCursor:tasks.rows.length>50?tasks.rows[49].id:null};
  });
}
