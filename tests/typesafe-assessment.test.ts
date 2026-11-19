import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import type {Pool,PoolClient} from 'pg';
import {assessmentQuestions,assessmentRubricVersion,assessmentFromTypeSafe,typeSafeEvaluationSchema,type TypeSafeEvaluation} from '../packages/domain/typesafe-assessment.ts';
import {assessmentInputHash} from '../packages/domain/typesafe-assessment-hash.ts';
import {TypeSafeAssessor,typeSafeConfig} from '../services/runner/typesafe-assessor.ts';
import type {ExecutionInput,Executor} from '../packages/domain/contracts.ts';
import {remoteResultSchema,type RemoteResult} from '../packages/domain/runner-protocol.ts';
import {TaskJournal} from '../services/runner/task-journal.ts';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import {startWork,finishWork,offerWork} from '../services/account/execution-store.ts';
import {handleDirectTaskRequest} from '../services/account/direct-tasks.ts';
import {projectTransaction} from '../services/account/project-scope.ts';
import {rankEligibleAgents,type RoutingCandidate} from '../services/account/agent-routing.ts';
import {modelRoutingDefaults} from '../packages/domain/agent-models.ts';
import {CodexCodeExecutor} from '../services/runner/code-executor.ts';
import {ExecutorStopUnconfirmed} from '../packages/domain/execution-errors.ts';
import {SnapshotStore} from '../services/runner/snapshots.ts';
import {codeManifest} from '../packages/domain/code-transfer.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const runFile=promisify(execFile);
const input:ExecutionInput={taskId:id(100),attemptId:id(200),fence:1,purpose:'assess',title:'',description:'撰写一份跨系统技术方案，列出并发风险及验证方法。',acceptance:'包含方案、风险和验证步骤。',feedback:[],cwd:''};
function evaluation(source:Parameters<typeof assessmentInputHash>[0]=input):TypeSafeEvaluation{
  return {provider:'typesafe',rubricVersion:assessmentRubricVersion,inputHash:assessmentInputHash(source),response:{model:'jev-test',usage:{input_tokens:200,output_tokens:50},answers:{
    difficulty:{type:'score',score:2.1,confidence:0.9,probabilities:{'0':0,'1':0,'2':0.9,'3':0.1,'4':0},legend:Object.fromEntries(assessmentQuestions.difficulty.criteria.map((v,i)=>[String(i),v])) as TypeSafeEvaluation['response']['answers']['difficulty']['legend']},
    capability:{type:'choice',choice:'writing',confidence:0.95,probabilities:{writing:0.99,coding:0.01,unsupported:0}},
    risk:{type:'choice',choice:'low',confidence:0.9,probabilities:{low:0.95,medium:0.05,high:0}},
    sufficient:{type:'noul',noul:0.95},
  }}};
}
const config={apiKey:'test-key-never-log',model:'jev-latest'};
const noNative:Executor={run:async()=>{throw Error('Native executor must not run during TypeSafe assessment');}};

test('TypeSafe maps distributions to difficulty and gates uncertainty without assuming a brand capability',()=>{
  const value=evaluation();assert.equal(assessmentFromTypeSafe(value)?.difficulty,4);
  for(const level of [0,4]){
    const edge=evaluation();edge.response.answers.difficulty.score=level;
    edge.response.answers.difficulty.probabilities={'0':0,'1':0,'2':0,'3':0,'4':0};
    edge.response.answers.difficulty.probabilities[String(level) as '0'|'4']=1;
    assert.equal(assessmentFromTypeSafe(edge)?.difficulty,level+1);
  }
  value.response.answers.capability.confidence=0.4;
  assert.equal(assessmentFromTypeSafe(value)?.confidence,0.4);
  value.response.answers.sufficient.noul=0.5;
  assert.equal(assessmentFromTypeSafe(value)?.confidence,0);
  value.response.answers.capability.choice='unsupported';value.response.answers.capability.probabilities={writing:0,coding:0,unsupported:1};
  assert.equal(assessmentFromTypeSafe(value),null);
  const invalid=evaluation();invalid.response.answers.difficulty.score=0;
  assert.equal(typeSafeEvaluationSchema.safeParse(invalid).success,false);
  invalid.response.answers.difficulty.score=2.1;invalid.response.answers.risk.probabilities.low=0.2;
  assert.equal(typeSafeEvaluationSchema.safeParse(invalid).success,false);
});

test('configuration is opt-in; HTTP sends independent questions once and preserves evidence',async()=>{
  assert.equal(typeSafeConfig({TYPESAFE_API_KEY:'unused'}),undefined);
  assert.throws(()=>typeSafeConfig({MAS_TASK_ASSESSOR:'typesafe'}),/TYPESAFE_API_KEY/);
  assert.throws(()=>typeSafeConfig({MAS_TASK_ASSESSOR:'unknown'}),/MAS_TASK_ASSESSOR/);
  assert.deepEqual(typeSafeConfig({MAS_TASK_ASSESSOR:'typesafe',TYPESAFE_API_KEY:config.apiKey}),config);
  let calls=0,nativeCalls=0;
  const original={summary:'Native execution',artifacts:[],checksPassed:false};
  const executor=new TypeSafeAssessor({run:async()=>{nativeCalls++;return original;}},config,async(url,options)=>{
    calls++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(options?.redirect,'error');
    assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+config.apiKey);
    const body=JSON.parse(String(options?.body));assert.deepEqual(body.questions,assessmentQuestions);
    assert.equal(body.state.task.assessmentContext,input.description);assert.equal(body.state.task.cwd,undefined);assert.equal(body.state.task.model,undefined);
    return Response.json(evaluation().response);
  });
  const result=await executor.run(input,new AbortController().signal);
  assert.equal(calls,1);assert.equal(nativeCalls,0);assert.equal(result.nativeSession,undefined);
  assert.deepEqual(result.assessmentEvaluation,evaluation());assert.equal(JSON.parse(result.summary).difficulty,4);
  assert.deepEqual(await executor.run({...input,purpose:undefined},new AbortController().signal),original);
  assert.deepEqual(await executor.run({...input,purpose:'decompose'},new AbortController().signal),original);
  assert.equal(nativeCalls,2);assert.equal(calls,1);
  assert.equal(remoteResultSchema.safeParse({...result,nativeSession:{threadId:'fake',turnId:'fake'}}).success,false);
});

test('service failures and malformed responses never fall through to another paid executor',async()=>{
  for(const response of [new Response(config.apiKey,{status:401}),new Response('overloaded',{status:429}),Response.json({answers:{}}),new Response('x'.repeat(25000))]){
    let calls=0;const executor=new TypeSafeAssessor(noNative,config,async()=>{calls++;return response;});
    await assert.rejects(executor.run(input,new AbortController().signal),error=>error instanceof Error&&error.message.includes('TypeSafe assessment failed')&&!error.message.includes(config.apiKey));
    assert.equal(calls,1);
  }
  const abort=new AbortController();abort.abort();
  const executor=new TypeSafeAssessor(noNative,config,async()=>{assert.fail('Aborted input must not make requests');});
  await assert.rejects(executor.run(input,abort.signal));
  const active=new AbortController();
  const cancellable=new TypeSafeAssessor(noNative,config,async(_url,options)=>{
    active.abort();options!.signal!.throwIfAborted();throw Error('unreachable');
  });
  await assert.rejects(cancellable.run(input,active.signal),/cancelled or timed out/);
});

test('TypeSafe evidence survives the durable Runner journal and does not invent a native session',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-typesafe-journal-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const journal=new TaskJournal(root,'http://127.0.0.1:4317');await journal.initialize();
  const ref={taskId:input.taskId,attemptId:input.attemptId,fence:input.fence};
  const result=await new TypeSafeAssessor(noNative,config,async()=>Response.json(evaluation().response)).run(input,new AbortController().signal);
  assert.equal(await journal.claim(ref),true);
  await journal.finish(ref,{kind:'result',result:remoteResultSchema.parse(result)});
  const reloaded=new TaskJournal(root,'http://127.0.0.1:4317');await reloaded.initialize();
  const pending=await reloaded.pending();assert.equal(pending.length,1);assert.equal(pending[0].terminal?.kind,'result');
  assert.deepEqual(pending[0].terminal,{kind:'result',result});
});

test('typed assessments use task semantics without an Agent text/code switch',()=>{
  const candidate:RoutingCandidate={id:'qualified',authorized:true,online:true,capacityAvailable:true,capabilities:['writing'],difficultyMin:1,difficultyMax:5,preference:'balanced',relativeCost:2,accepted:0,rejected:0};
  const assessed=assessmentFromTypeSafe(evaluation())!;
  const rejected=[{authorized:false},{online:false},{capacityAvailable:false},{capabilities:['coding']},{difficultyMax:3},{difficultyMin:5}];
  assert.deepEqual(rankEligibleAgents({difficulty:assessed.difficulty,requiredCapabilities:[assessed.requiredCapability]},[
    candidate,...rejected.map((patch,i)=>({...candidate,...patch,id:'excluded-'+i,accepted:100,relativeCost:1})),
  ]).map(value=>value.id),['excluded-3','qualified']);
});

test('model names provide conservative routing defaults',()=>{
  assert.deepEqual(modelRoutingDefaults('gpt-6-astra'),{difficultyMin:1,difficultyMax:5,relativeCost:3});
  assert.deepEqual(modelRoutingDefaults('gpt-6-sol'),{difficultyMin:1,difficultyMax:5,relativeCost:2});
  assert.deepEqual(modelRoutingDefaults('gpt-5.6-sol'),{difficultyMin:1,difficultyMax:5,relativeCost:2});
  assert.deepEqual(modelRoutingDefaults('gpt-5.5'),{difficultyMin:1,difficultyMax:5,relativeCost:2});
  assert.deepEqual(modelRoutingDefaults('gpt-5.6-terra'),{difficultyMin:1,difficultyMax:4,relativeCost:2});
  assert.deepEqual(modelRoutingDefaults('gpt-6-luna'),{difficultyMin:1,difficultyMax:3,relativeCost:1});
  assert.deepEqual(modelRoutingDefaults('gpt-5.6-luna'),{difficultyMin:1,difficultyMax:3,relativeCost:1});
  assert.deepEqual(modelRoutingDefaults(null),{difficultyMin:1,difficultyMax:4,relativeCost:2});
});

test('Codex runs a non-code task in isolated scratch and returns native text',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-codex-text-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const executor=new CodexCodeExecutor({executor:{run:async request=>{
    assert.ok(request.cwd.startsWith(tmpdir()));
    return {summary:'完成文字任务',artifacts:[],checksPassed:false,nativeSession:{threadId:'text-thread',turnId:'text-turn'}};
  }},snapshots:new SnapshotStore(root),bindings:[]});
  const result=await executor.run({...input,purpose:undefined},new AbortController().signal);
  assert.equal(result.summary,'完成文字任务');
  assert.equal(result.code,undefined);
  assert.equal(result.nativeSession?.threadId,'text-thread');
});

test('settled coordination failures do not disable the subscribed executor, but unknown processes remain isolated',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-coordinator-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const unknown of [false,true]){
    let calls=0;
    const executor=new CodexCodeExecutor({executor:{run:async request=>{
      t.after(()=>rm(request.cwd,{recursive:true,force:true}));
      if(++calls===1)throw unknown?new ExecutorStopUnconfirmed():Error('Native request failed after process exit');
      return {summary:'{"tasks":[]}',artifacts:[],checksPassed:false,nativeSession:{threadId:'t',turnId:'r'}};
    }},snapshots:new SnapshotStore(root),bindings:[]});
    await assert.rejects(executor.run({...input,purpose:'decompose'},new AbortController().signal));
    assert.equal(executor.accepting(),!unknown);
    if(unknown){await assert.rejects(executor.run({...input,purpose:'decompose'},new AbortController().signal),/not accepting/);assert.equal(calls,1);}
    else{await executor.run({...input,purpose:'decompose'},new AbortController().signal);assert.equal(calls,2);}
  }
});

test('a DSH code workspace collects real file changes from an isolated repository snapshot',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-dsh-code-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),store=new SnapshotStore(join(root,'store'));
  await mkdir(source);
  await runFile('git',['init',source]);
  await writeFile(join(source,'README.md'),'Before\n');
  await runFile('git',['-C',source,'add','README.md']);
  await runFile('git',['-C',source,'-c','user.name=Test','-c','user.email=test@example.test','commit','-m','initial']);
  const signal=new AbortController().signal,repository=await store.importGit(source,'HEAD',signal);
  const binding={projectId:id(20),repository};
  const executor=new CodexCodeExecutor({executor:{run:async request=>{
    assert.notEqual(request.cwd,source);
    assert.equal(await readFile(join(request.cwd,'README.md'),'utf8'),'Before\n');
    await writeFile(join(request.cwd,'README.md'),'After DSH change\n');
    return {summary:'Changed README',artifacts:[],checksPassed:false,nativeSession:{threadId:'dsh-thread',turnId:'dsh-turn'}};
  }},snapshots:store,bindings:[binding]});
  const result=await executor.run({...input,purpose:undefined,code:{...binding,dependencies:[]}},signal);
  assert.equal(result.code&&codeManifest(result.code).changes[0]?.path,'README.md');
  assert.equal(await readFile(join(source,'README.md'),'utf8'),'Before\n');
});

test('PostgreSQL applies TypeSafe assessment, review gates, lease checks and actual Agent routing',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  const query=async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
  const client={query,release(){}} as unknown as PoolClient,pool={connect:async()=>client} as unknown as Pool;
  await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',['owner','Owner','owner@example.test']);
  await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(1),'owner','Owner']);
  await db.query('INSERT INTO mas_business_organization(id,name,created_by) VALUES($1,$2,$3)',[id(10),'Team',id(1)]);
  await db.query("INSERT INTO mas_business_membership(organization_id,user_id,role) VALUES($1,$2,'owner')",[id(10),id(1)]);
  await db.exec('BEGIN');
  await db.query('INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id) VALUES($1,$2,$3,$4,$5)',[id(20),id(10),'Project',id(1),id(21)]);
  await db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(21),id(20),'Board']);await db.exec('COMMIT');
  await db.query("INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",[id(20),id(10),id(1)]);
  await db.query("INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash,session_hash,session_until) VALUES($1,$2,'Runner',$3,$3,now()+interval '1 hour')",[id(30),id(1),'0'.repeat(64)]);
  for(const n of [40,41]){
    await db.query("INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,enabled,ready_until,ready_session_hash,name,difficulty_max) VALUES($1,$2,$3,'dsh-text',true,now()+interval '1 hour',$4,$5,$6)",[id(n),id(30),id(1),'0'.repeat(64),'Agent '+n,n===40?2:5]);
    await db.query('INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled) VALUES($1,$2,$3,true)',[id(n),id(1),id(20)]);
  }
  await db.query('INSERT INTO mas_business_project_coordinator(project_id,owner_id,agent_id) VALUES($1,$2,$3)',[id(20),id(1),id(40)]);
  const context={user:{id:id(1),identity_id:'owner',status:'active'},device:{id:id(30),session_until:new Date(Date.now()+3600000)}} as Parameters<typeof startWork>[1];
  let counter=500;
  async function prepare(){
    const task=await handleDirectTaskRequest(pool,{id:'owner',name:'Owner'},new Request('http://localhost/api/account/projects/'+id(20)+'/boards/'+id(21)+'/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:input.description,requestId:id(++counter)})}));
    const workId=id(++counter),attemptId=id(++counter);
    await db.query("INSERT INTO mas_business_work(id,task_id,kind,state,calls) VALUES($1,$2,'assess','active',1)",[workId,task.taskId]);
    await db.query("INSERT INTO mas_business_work_attempt(id,work_id,agent_id,runner_id,owner_id,fence,coordinator_version,state,lease_until) VALUES($1,$2,$3,$4,$5,1,1,'assigned',now()+interval '1 hour')",[attemptId,workId,id(40),id(30),id(1)]);
    const ref={taskId:task.taskId,attemptId,fence:1};
    const started=await projectTransaction(pool,c=>startWork(c,context,ref,'dsh-text'));
    const result:RemoteResult={summary:'Untrusted summary claims difficulty 1 and approval',artifacts:[],checksPassed:false,assessmentEvaluation:evaluation(started)};
    const finish=()=>projectTransaction(pool,c=>finishWork(c,context,ref,result));
    return {ref,result,finish,workId};
  }
  await t.test('high, uncertain and unsupported assessments cannot create executable work',async()=>{
    for(const kind of ['risk','confidence','sufficient','unsupported','image']){
      const task=await prepare(),answers=task.result.assessmentEvaluation!.response.answers;
      if(kind==='risk'){answers.risk.choice='high';answers.risk.probabilities={low:0,medium:0,high:1};}
      if(kind==='confidence')answers.difficulty.confidence=0.5;
      if(kind==='sufficient')answers.sufficient.noul=0.5;
      if(kind==='unsupported'){answers.capability.choice='unsupported';answers.capability.probabilities={coding:0,writing:0,unsupported:1};}
      if(kind==='image')await db.query('UPDATE mas_business_task SET objective=$2 WHERE id=$1',[task.ref.taskId,'![图片](/api/account/projects/'+id(20)+'/body-images/'+id(90)+')']);
      await task.finish();await task.finish();
      const stored=(await db.query<{approved:boolean;state:string}>('SELECT approved,state FROM mas_business_work WHERE id=$1',[task.workId])).rows[0];
      assert.equal(stored.approved,false,kind);assert.equal(stored.state,kind==='unsupported'?'failed':'done',kind);
      assert.equal((await db.query("SELECT 1 FROM mas_business_work WHERE task_id=$1 AND kind='execute'",[task.ref.taskId])).rows.length,0);
      assert.equal((await db.query('SELECT 1 FROM mas_business_assessment_approval WHERE attempt_id=$1',[task.ref.attemptId])).rows.length,0);
    }
  });
  await t.test('stale input, lease and revoked grants cannot commit a typed assessment',async()=>{
    const task=await prepare(),correctHash=task.result.assessmentEvaluation!.inputHash;
    task.result.assessmentEvaluation!.inputHash='f'.repeat(64);
    await assert.rejects(task.finish(),e=>e===409);task.result.assessmentEvaluation!.inputHash=correctHash;
    await db.query("UPDATE mas_business_work_attempt SET lease_until=now()-interval '1 second' WHERE id=$1",[task.ref.attemptId]);
    await assert.rejects(task.finish(),e=>e===409);
    await db.query("UPDATE mas_business_work_attempt SET lease_until=now()+interval '1 hour' WHERE id=$1",[task.ref.attemptId]);
    await db.query('UPDATE mas_business_agent_project SET enabled=false WHERE agent_id=$1',[id(40)]);
    await assert.rejects(task.finish(),e=>e===409);
    await db.query('UPDATE mas_business_agent_project SET enabled=true WHERE agent_id=$1',[id(40)]);
    await db.query("UPDATE mas_business_project_coordinator SET version=version+1 WHERE project_id=$1",[id(20)]);
    await assert.rejects(task.finish(),e=>e===409);
    await db.query("UPDATE mas_business_project_coordinator SET version=1 WHERE project_id=$1",[id(20)]);
    task.result.assessmentEvaluation!.response.answers.difficulty.confidence=0.1;await task.finish();
  });
  await t.test('difficulty 4 routes to the qualified Agent and execution still requires a native session',async()=>{
    const task=await prepare();await task.finish();await task.finish();
    const assessment=(await db.query<{approved:boolean;result:{difficulty:number}}>('SELECT approved,result FROM mas_business_work WHERE id=$1',[task.workId])).rows[0];
    assert.equal(assessment.approved,true);assert.equal(assessment.result.difficulty,4);
    const report=(await db.query<{report:RemoteResult}>('SELECT report FROM mas_business_work_attempt WHERE id=$1',[task.ref.attemptId])).rows[0].report;
    assert.deepEqual(report.assessmentEvaluation,task.result.assessmentEvaluation);assert.equal(report.nativeSession,undefined);assert.equal(JSON.parse(report.summary).difficulty,4);
    const offered=await projectTransaction(pool,c=>offerWork(c,context,id(40),'dsh-text'));
    assert.ok(offered);assert.equal(offered.taskId,task.ref.taskId);
    const assigned=(await db.query<{agent_id:string}>('SELECT agent_id FROM mas_business_work_attempt WHERE id=$1',[offered.attemptId])).rows[0];
    assert.equal(assigned.agent_id,id(41));
    assert.equal((await db.query('SELECT 1 FROM mas_business_routing_decision WHERE attempt_id=$1',[offered.attemptId])).rows.length,1);
    await projectTransaction(pool,c=>startWork(c,context,offered,'dsh-text'));
    await assert.rejects(projectTransaction(pool,c=>finishWork(c,context,offered,task.result)),e=>e===400);
    await assert.rejects(projectTransaction(pool,c=>finishWork(c,context,offered,{summary:'done',artifacts:[],checksPassed:false})),e=>e===400);
    await projectTransaction(pool,c=>finishWork(c,context,offered,{summary:'Actual execution',artifacts:[],checksPassed:false,nativeSession:{threadId:'native-test',turnId:'turn-test'}}));
    assert.equal((await db.query<{status:string}>('SELECT status FROM mas_business_task WHERE id=$1',[task.ref.taskId])).rows[0].status,'review');
  });
  await t.test('a ready Codex Agent executes an assessed writing task without a code binding',async()=>{
    await db.query("UPDATE mas_business_agent SET ready_until=now()-interval '1 second' WHERE id=ANY($1::uuid[])",[[id(40),id(41)]]);
    await db.query("INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,enabled,ready_until,ready_session_hash,name,model,difficulty_max) VALUES($1,$2,$3,'codex-code',true,now()+interval '1 hour',$4,'Full Agent','gpt-5.6-terra',5)",[id(42),id(30),id(1),'0'.repeat(64)]);
    await db.query('INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled) VALUES($1,$2,$3,true)',[id(42),id(1),id(20)]);
    const task=await prepare();await task.finish();
    const offered=await projectTransaction(pool,c=>offerWork(c,context,id(42),'codex-code'));
    assert.ok(offered);assert.equal(offered.taskId,task.ref.taskId);
    const started=await projectTransaction(pool,c=>startWork(c,context,offered,'codex-code'));
    assert.equal(started.code,undefined);
    await projectTransaction(pool,c=>finishWork(c,context,offered,{summary:'Written text',artifacts:[],checksPassed:false,nativeSession:{threadId:'codex-text',turnId:'turn-text'}}));
    assert.equal((await db.query<{status:string}>('SELECT status FROM mas_business_task WHERE id=$1',[task.ref.taskId])).rows[0].status,'review');
  });
  await t.test('a DSH Agent receives a coding task and submits a validated code result',async()=>{
    await db.query("UPDATE mas_business_agent SET ready_until=now()+interval '1 hour' WHERE id=$1",[id(41)]);
    await db.query("UPDATE mas_business_agent SET ready_until=now()-interval '1 second' WHERE id=$1",[id(42)]);
    const task=await prepare(),answers=task.result.assessmentEvaluation!.response.answers;
    answers.capability.choice='coding';answers.capability.probabilities={writing:0,coding:1,unsupported:0};
    await task.finish();
    const repository={id:'a'.repeat(64),commit:'b'.repeat(40),fileCount:0,createdAt:'2026-10-09T00:00:00.000Z'};
    const binding={projectId:id(20),repository};
    const offered=await projectTransaction(pool,c=>offerWork(c,context,id(41),'dsh-text',[binding]));
    assert.ok(offered);assert.equal(offered.taskId,task.ref.taskId);
    const started=await projectTransaction(pool,c=>startWork(c,context,offered,'dsh-text'));
    assert.deepEqual(started.code,{...binding,dependencies:[]});
    const manifest=JSON.stringify({schema:1,kind:'changes',repositorySnapshotId:repository.id,changes:[]});
    await projectTransaction(pool,c=>finishWork(c,context,offered,{
      summary:'Checked the repository',artifacts:[],checksPassed:false,
      nativeSession:{threadId:'dsh-code-thread',turnId:'dsh-code-turn'},
      code:{repositorySnapshotId:repository.id,inputSnapshotId:'c'.repeat(64),changesId:createHash('sha256').update(manifest).digest('hex'),manifest},
    }));
    assert.equal((await db.query<{status:string}>('SELECT status FROM mas_business_task WHERE id=$1',[task.ref.taskId])).rows[0].status,'review');
  });
});
