import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import {handleTaskRetry,taskRetryRoute} from '../services/account/task-retry.ts';
import {handleDirectTaskRequest} from '../services/account/direct-tasks.ts';
import {handleTaskActivity} from '../services/account/task-activity.ts';
import {authorizeRunnerSession,hashRunnerSecret} from '../services/account/runner-connections.ts';
import {projectTransaction} from '../services/account/project-scope.ts';
import {offerWork,startWork,stopWork} from '../services/account/execution-store.ts';
import {handleTaskRework} from '../services/account/task-rework.ts';
import {createAccountService} from '../services/account/service.ts';
import type {IdentityService} from '../services/identity/service.ts';
import {handleExecutionRequest} from '../services/account/execution-routes.ts';
import {handleExecutionRecovery} from '../services/account/execution-recovery.ts';
import {mutateBoard} from '../services/account/boards.ts';
import {createStory} from '../services/account/stories.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner={id:'owner',name:'Owner'},manager={id:'manager',name:'Manager'},viewer={id:'viewer',name:'Viewer'},observer={id:'observer',name:'Observer'};
const credential='a'.repeat(64),sessionId='b'.repeat(64);
async function fixture(t:TestContext){
  const db=new PGlite();t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  const pool={connect:async()=>({query:async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};},release(){}})} as unknown as Pool;
  for(const [index,actor] of [owner,manager,viewer,observer].entries()){
    await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',[actor.id,actor.name,actor.id+'@example.test']);
    await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(index+1),actor.id,actor.name]);
  }
  await db.query('INSERT INTO mas_business_organization(id,name,created_by) VALUES($1,$2,$3)',[id(10),'Team',id(1)]);
  for(let user=1;user<=4;user++)await db.query('INSERT INTO mas_business_membership(organization_id,user_id,role) VALUES($1,$2,$3)',[id(10),id(user),user===1||user===4?'owner':'member']);
  for(const project of [20,22]){
    await db.exec('BEGIN');
    await db.query('INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id) VALUES($1,$2,$3,$4,$5)',[id(project),id(10),'Project',id(1),id(project+1)]);
    await db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(project+1),id(project),'Board']);await db.exec('COMMIT');
    for(let user=1;user<=3;user++)await db.query('INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role) VALUES($1,$2,$3,$4)',[id(project),id(10),id(user),user===1?'owner':user===2?'manager':'viewer']);
  }
  await db.query("INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash,session_hash,session_until) VALUES($1,$2,'Runner',$3,$4,now()+interval '1 hour')",[id(30),id(1),hashRunnerSecret(credential),hashRunnerSecret(sessionId)]);
  await db.query("INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,name,enabled,ready_until,ready_session_hash) VALUES($1,$2,$3,'demo','Executor',true,now()+interval '1 hour',$4)",[id(40),id(30),id(1),hashRunnerSecret(sessionId)]);
  await db.query('INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled) VALUES($1,$2,$3,true)',[id(40),id(1),id(20)]);
  const {taskId}=await handleDirectTaskRequest(pool,owner,new Request('https://example.test/api/account/projects/'+id(20)+'/boards/'+id(21)+'/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:'Keep this task input',requestId:id(100)})}));
  const assessment={difficulty:4,risk:'high',confidence:0.78,rationale:'Explicitly approved',requiredCapability:'writing'};
  await db.query("INSERT INTO mas_business_work(id,task_id,kind,state,calls,approved,result) VALUES($1,$2,'assess','done',1,true,$3)",[id(50),taskId,JSON.stringify(assessment)]);
  await db.query("INSERT INTO mas_business_work(id,task_id,kind,state,calls,issues) VALUES($1,$2,'execute','failed',1,'[\"Execution stopped\"]')",[id(51),taskId]);
  for(const [attempt,work,state] of [[60,51,'stopped'],[61,50,'finished']] as const)await db.query("INSERT INTO mas_business_work_attempt(id,work_id,agent_id,runner_id,owner_id,fence,state,lease_until,finished_at,input_revision) VALUES($1,$2,$3,$4,$5,1,$6,now(),now(),1)",[id(attempt),id(work),id(40),id(30),id(1),state]);
  await db.query('INSERT INTO mas_business_assessment_approval(attempt_id,actor_id) VALUES($1,$2)',[id(61),id(1)]);
  await db.query("UPDATE mas_business_task SET status='failed',required_capabilities=ARRAY['writing'] WHERE id=$1",[taskId]);
  const path=(project=id(20))=>'https://example.test/api/account/projects/'+project+'/tasks/'+taskId+'/retry';
  const input={identityId:owner.id,requestId:id(101),expectedRevision:1,expectedAttemptId:id(60)};
  const read=(actor=owner,project=id(20))=>handleTaskRetry(pool,actor,new Request(path(project))) as Promise<{identityId:string;taskId:string;revision:number;attemptId:string|null;canRetry:boolean;reason:string|null;retryCount:number;retryLimit:number}>;
  const retry=(body:Record<string,unknown>=input,actor=owner,project=id(20))=>handleTaskRetry(pool,actor,new Request(path(project),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  const runner=<T>(operation:(client:Parameters<typeof authorizeRunnerSession>[0],context:Awaited<ReturnType<typeof authorizeRunnerSession>>)=>Promise<T>)=>projectTransaction(pool,async client=>operation(client,await authorizeRunnerSession(client,{runnerId:id(30),sessionId},hashRunnerSecret(credential))));
  return {db,pool,taskId,assessment,input,read,retry,runner};
}

test('task retry is an authenticated GET and POST route',()=>{
  const path='https://example.test/api/account/projects/'+id(20)+'/tasks/'+id(70)+'/retry';
  assert.equal(taskRetryRoute(new Request(path)),true);
  assert.equal(taskRetryRoute(new Request(path,{method:'POST'})),true);
  assert.equal(taskRetryRoute(new Request(path,{method:'DELETE'})),false);
});

test('manual retry preserves input, approved assessment and history, then dispatches a fresh attempt',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.read(),{identityId:owner.id,taskId:f.taskId,revision:1,attemptId:id(60),canRetry:true,reason:null,retryCount:0,retryLimit:3});
  const original=(await f.db.query<Record<string,unknown>>('SELECT title,objective,acceptance_criteria,required_capabilities FROM mas_business_task WHERE id=$1',[f.taskId])).rows[0];
  assert.equal(await f.runner((client,context)=>offerWork(client,context,id(40),'demo')),null,'a stopped failure never retries itself');
  assert.deepEqual(await f.retry(),{identityId:owner.id,ok:true});
  assert.deepEqual(await f.retry(),{identityId:owner.id,ok:true});
  const task=(await f.db.query('SELECT title,objective,acceptance_criteria,required_capabilities,status,input_revision FROM mas_business_task WHERE id=$1',[f.taskId])).rows[0];
  assert.deepEqual(task,{...original,status:'pending',input_revision:1});
  const assessment=(await f.db.query('SELECT state,calls,approved,result FROM mas_business_work WHERE id=$1',[id(50)])).rows[0];
  assert.deepEqual(assessment,{state:'done',calls:1,approved:true,result:f.assessment});
  assert.deepEqual((await f.db.query('SELECT state,calls,round_start_calls,result,issues FROM mas_business_work WHERE id=$1',[id(51)])).rows[0],{state:'queued',calls:1,round_start_calls:1,result:null,issues:[]});
  const receipts=(await f.db.query<{previous:{issues:string[]}}>('SELECT * FROM mas_business_task_retry WHERE task_id=$1',[f.taskId])).rows;
  assert.equal(receipts.length,1);assert.deepEqual(receipts[0].previous.issues,['Execution stopped']);
  assert.equal((await f.db.query<{state:string}>('SELECT state FROM mas_business_work_attempt WHERE id=$1',[id(60)])).rows[0].state,'stopped');
  const activity=await handleTaskActivity(f.pool,owner,new Request('https://example.test/api/account/projects/'+id(20)+'/tasks/'+f.taskId+'/activity'));
  assert.ok(activity.items?.some((item:{operation:string;body:string})=>item.operation==='retry'&&item.body==='人工重试执行'));
  await f.db.query('UPDATE mas_business_agent_project SET enabled=false WHERE agent_id=$1',[id(40)]);
  assert.equal(await f.runner((client,context)=>offerWork(client,context,id(40),'demo')),null,'retry does not bypass project grants');
  await f.db.query('UPDATE mas_business_agent_project SET enabled=true WHERE agent_id=$1',[id(40)]);
  const next=await f.runner((client,context)=>offerWork(client,context,id(40),'demo'));
  assert.ok(next);assert.notEqual(next.attemptId,id(60));assert.equal(next.fence,2);
  const start=await f.runner((client,context)=>startWork(client,context,next,'demo'));
  assert.ok(start.description.includes('Keep this task input'));
  assert.equal((await f.db.query<{input_revision:number}>('SELECT input_revision FROM mas_business_work_attempt WHERE id=$1',[next.attemptId])).rows[0].input_revision,1);
  assert.deepEqual(await f.retry(),{identityId:owner.id,ok:true},'a lost successful response replays without restarting current work');
  await f.runner((client,context)=>stopWork(client,context,{taskId:f.taskId,attemptId:id(60),fence:1}));
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM mas_business_task WHERE id=$1',[f.taskId])).rows[0].status,'running','old stop receipts cannot overwrite the next attempt');
});

test('manual retry rechecks Owner access, identity, project scope and request identity',async t=>{
  const f=await fixture(t);
  for(const actor of [manager,viewer,observer]){
    assert.equal((await f.read(actor)).reason,'owner_required');
    await assert.rejects(()=>f.retry({...f.input,identityId:actor.id},actor),error=>error===403||error===404);
  }
  await assert.rejects(()=>f.retry({...f.input,identityId:manager.id}),error=>error===403);
  await assert.rejects(()=>f.read(owner,id(22)),error=>error===404);
  await assert.rejects(()=>f.retry({...f.input,expectedRevision:2}),error=>error===409);
  await assert.rejects(()=>f.retry({...f.input,expectedAttemptId:id(61)}),error=>error===409);
  await f.retry();
  await assert.rejects(()=>f.retry({...f.input,expectedAttemptId:id(61)}),error=>error===409);
  await assert.rejects(()=>f.retry({...f.input,requestId:id(102)}),error=>error===409);
  await f.db.query("UPDATE mas_business_project_member SET status='suspended' WHERE project_id=$1 AND user_id=$2",[id(20),id(1)]);
  await assert.rejects(()=>f.retry(),error=>error===404);
});

test('manual retry never treats an expired lease or a finished rejected report as a stopped execution',async t=>{
  const f=await fixture(t);
  await f.db.query("UPDATE mas_business_work_attempt SET state='running',finished_at=NULL,lease_until=to_timestamp(0) WHERE id=$1",[id(60)]);
  assert.equal((await f.read()).reason,'unsettled');
  await assert.rejects(()=>f.retry(),error=>error===409);
  await f.db.query("UPDATE mas_business_work_attempt SET state='finished',finished_at=now() WHERE id=$1",[id(60)]);
  assert.equal((await f.read()).reason,'attempt_not_stopped');
  await assert.rejects(()=>f.retry(),error=>error===409);
  await f.db.query("UPDATE mas_business_work_attempt SET state='stopped',input_revision=NULL WHERE id=$1",[id(60)]);
  assert.equal((await f.read()).reason,'attempt_not_stopped','legacy unknown provenance is not guessed');
  await f.db.query('UPDATE mas_business_work_attempt SET input_revision=1 WHERE id=$1',[id(60)]);
  await f.db.query('UPDATE mas_business_work SET approved=false WHERE id=$1',[id(50)]);
  assert.equal((await f.read()).reason,'assessment_required');
  await assert.rejects(()=>f.retry(),error=>error===409);
});

test('manual retry allows three explicit retries per input revision and preserves monotonic attempt fences',async t=>{
  const f=await fixture(t);let previous=id(60);
  for(let revision=1;revision<4;revision++){
    await f.retry({...f.input,requestId:id(100+revision),expectedRevision:1,expectedAttemptId:previous});
    const next=await f.runner((client,context)=>offerWork(client,context,id(40),'demo'));assert.ok(next);assert.equal(next.fence,revision+1);
    await f.runner((client,context)=>stopWork(client,context,next));previous=next.attemptId;
  }
  assert.equal((await f.read()).reason,'retry_limit');
  await assert.rejects(()=>f.retry({...f.input,requestId:id(105),expectedRevision:1,expectedAttemptId:previous}),error=>error===409);
  assert.equal((await f.db.query('SELECT * FROM mas_business_task_retry WHERE task_id=$1',[f.taskId])).rows.length,3);
  assert.equal((await f.db.query('SELECT * FROM mas_business_work_attempt WHERE work_id=$1',[id(51)])).rows.length,4);
  await handleTaskRework(f.pool,owner,new Request('https://example.test/api/account/projects/'+id(20)+'/tasks/'+f.taskId+'/rework',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identityId:owner.id,requestId:id(200),expectedRevision:1,title:'',objective:'Revised requirement',acceptanceCriteria:'Human review',requiredCapability:'writing',reason:'Changed requirements'})}));
  const revised=await f.read();assert.equal(revised.revision,2);assert.equal(revised.retryCount,0);
  await f.db.query("UPDATE mas_business_work SET state='done',approved=true,result=$2 WHERE id=$1",[id(50),JSON.stringify(f.assessment)]);
  const next=await f.runner((client,context)=>offerWork(client,context,id(40),'demo'));assert.ok(next);assert.equal(next.fence,5);
  await f.runner((client,context)=>stopWork(client,context,next));
  await f.retry({...f.input,requestId:id(201),expectedRevision:2,expectedAttemptId:next.attemptId});
  assert.equal((await f.read()).retryCount,1,'a real input revision receives an independent retry budget');
});

test('manual retry HTTP route enforces authenticated same-origin writes',async t=>{
  const f=await fixture(t);let signedIn=true;
  const app=createAccountService({pool:f.pool,origin:'https://example.test',identity:{principal:async()=>signedIn?owner:null} as unknown as IdentityService});
  const path='https://example.test/api/account/projects/'+id(20)+'/tasks/'+f.taskId+'/retry';
  for(const origin of [undefined,'https://other.test'])assert.equal((await app.handle(new Request(path,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(f.input)}))).status,403);
  signedIn=false;assert.equal((await app.handle(new Request(path))).status,401);
  signedIn=true;
  assert.equal((await app.handle(new Request(path))).status,200);
  const response=await app.handle(new Request(path,{method:'POST',headers:{origin:'https://example.test','content-type':'application/json'},body:JSON.stringify(f.input)}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{identityId:owner.id,ok:true});
});

test('manual retry cannot requeue a task after another manager archives its historical board',async t=>{
  const f=await fixture(t);assert.equal((await f.read()).canRetry,true);
  await f.db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(24),id(20),'Current board']);
  await f.db.query('UPDATE mas_business_project SET default_board_id=$2 WHERE id=$1',[id(20),id(24)]);
  await mutateBoard(f.pool,manager.id,id(20),{kind:'archive',boardId:id(21),requestId:id(300)});
  await assert.rejects(()=>f.read(),error=>error===404);
  await assert.rejects(()=>f.retry(),error=>error===404);
  assert.equal((await f.db.query('SELECT * FROM mas_business_task_retry WHERE task_id=$1',[f.taskId])).rows.length,0);
  assert.equal((await f.db.query<{status:string}>('SELECT status FROM mas_business_task WHERE id=$1',[f.taskId])).rows[0].status,'failed');
});

test('stopped reports accept only safe reasons and retain the first reason through retry',async t=>{
  const f=await fixture(t);
  await f.db.query("UPDATE mas_business_work_attempt SET state='running',finished_at=NULL WHERE id=$1",[id(60)]);
  const stopped=(extra:Record<string,unknown>)=>handleExecutionRequest(f.pool,new Request('https://example.test/api/runner/tasks/stopped',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(30),sessionId,ref:{taskId:f.taskId,attemptId:id(60),fence:1},...extra})}),['demo']);
  await assert.rejects(()=>stopped({reason:'timeout with secret-token'}));
  await assert.rejects(()=>stopped({reason:'timeout',message:'raw private error'}));
  assert.equal((await f.db.query<{state:string}>('SELECT state FROM mas_business_work_attempt WHERE id=$1',[id(60)])).rows[0].state,'running');
  await stopped({reason:'timeout'});await stopped({reason:'execution_failed'});
  assert.equal((await f.db.query<{stop_reason:string}>('SELECT stop_reason FROM mas_business_work_attempt WHERE id=$1',[id(60)])).rows[0].stop_reason,'timeout');
  const issues=(await f.db.query<{issues:string[]}>('SELECT issues FROM mas_business_work WHERE id=$1',[id(51)])).rows[0].issues;
  assert.match(issues[0],/超过时限/);assert.doesNotMatch(issues[0],/secret|private/);
  await f.retry();
  const activity=await handleTaskActivity(f.pool,owner,new Request('https://example.test/api/account/projects/'+id(20)+'/tasks/'+f.taskId+'/activity'));
  assert.ok(activity.items?.some((item:{operation:string;body:string})=>item.operation==='stopped'&&item.body===issues[0]),'queued retry must not erase the previous failure diagnosis');
});

for(const channel of ['legacy-runner','human-confirmation'])test(`${channel} stop evidence is not mislabeled as an execution error`,async t=>{
  const f=await fixture(t);
  await f.db.query("UPDATE mas_business_work_attempt SET state='running',finished_at=NULL,lease_until=to_timestamp(0) WHERE id=$1",[id(60)]);
  if(channel==='legacy-runner')await handleExecutionRequest(f.pool,new Request('https://example.test/api/runner/tasks/stopped',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(30),sessionId,ref:{taskId:f.taskId,attemptId:id(60),fence:1}})}),['demo']);
  else await handleExecutionRecovery(f.pool,owner,new Request('https://example.test/api/account/execution-recovery/'+id(60)+'/confirm-stopped',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identityId:owner.id,runnerId:id(30),fence:1,confirmedStopped:true})}));
  assert.equal((await f.db.query<{stop_reason:string|null}>('SELECT stop_reason FROM mas_business_work_attempt WHERE id=$1',[id(60)])).rows[0].stop_reason,null);
  assert.deepEqual((await f.db.query<{issues:string[]}>('SELECT issues FROM mas_business_work WHERE id=$1',[id(51)])).rows[0].issues,['Execution stopped; inspect permissions, account and prior attempt before retrying']);
  assert.equal((await f.read()).canRetry,true);
});

test('story coordination stores the same bounded stop reason without changing its recovery policy',async t=>{
  const f=await fixture(t);
  await f.db.query("UPDATE mas_business_agent SET profile='dsh-text' WHERE id=$1",[id(40)]);
  await f.db.query('INSERT INTO mas_business_project_coordinator(project_id,owner_id,agent_id) VALUES($1,$2,$3)',[id(20),id(1),id(40)]);
  const {story}=await createStory(f.pool,owner.id,id(20),id(21),{title:'A story',body:'Story body',requestId:id(400)});
  await f.db.query("INSERT INTO mas_business_story_assistance(id,project_id,story_id,story_version,requester_id,request_id,state,calls) VALUES($1,$2,$3,1,$4,$5,'running',1)",[id(70),id(20),story.id,id(1),id(401)]);
  await f.db.query("INSERT INTO mas_business_work_attempt(id,story_job_id,agent_id,runner_id,owner_id,fence,coordinator_version,state,lease_until) VALUES($1,$2,$3,$4,$5,1,1,'running',now()+interval '1 hour')",[id(71),id(70),id(40),id(30),id(1)]);
  const stop=(reason:string)=>handleExecutionRequest(f.pool,new Request('https://example.test/api/runner/tasks/stopped',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(30),sessionId,ref:{taskId:story.id,attemptId:id(71),fence:1},reason})}),['dsh-text']);
  await stop('execution_failed');await stop('timeout');
  assert.deepEqual((await f.db.query<{state:string;issues:string[];version:number}>('SELECT state,issues,version FROM mas_business_story_assistance WHERE id=$1',[id(70)])).rows[0],{state:'failed',issues:['执行异常并已停止，请检查执行环境后人工重试。'],version:2});
  assert.equal((await f.db.query<{stop_reason:string}>('SELECT stop_reason FROM mas_business_work_attempt WHERE id=$1',[id(71)])).rows[0].stop_reason,'execution_failed');
  assert.deepEqual((await f.db.query('SELECT paused,version FROM mas_business_project_coordinator WHERE project_id=$1',[id(20)])).rows[0],{paused:true,version:2});
});
