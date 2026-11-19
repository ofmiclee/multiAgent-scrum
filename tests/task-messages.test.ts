import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import {executionRoute,handleExecutionRequest,handleTaskReview} from '../services/account/execution-routes.ts';
import {hashRunnerSecret} from '../services/account/runner-connections.ts';
import {handleDirectTaskRequest} from '../services/account/direct-tasks.ts';
import {runnerTaskMessageResponseSchema,taskInteractiveConversationResponseSchema,taskMessageReceiptSchema} from '../packages/domain/task-conversation.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const owner={id:'owner',name:'Owner'},member={id:'member',name:'Member'},viewer={id:'viewer',name:'Viewer'},organizationOwner={id:'organization-owner',name:'Organization owner'};
const credential='a'.repeat(64),sessionId='b'.repeat(64);
const rejected=(error:unknown)=>[403,404,409,429].includes(error as number);

async function fixture(t:TestContext,beforeQuery?:(sql:string)=>void){
 const db=new PGlite();t.after(()=>db.close());
 for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
 const pool={connect:async()=>({query:async(sql:string,args?:unknown[])=>{beforeQuery?.(sql);const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};},release(){}})} as unknown as Pool;
 for(const [index,actor] of [owner,member,viewer,organizationOwner].entries()){
  await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',[actor.id,actor.name,actor.id+'@example.test']);
  await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(index+1),actor.id,actor.name]);
 }
 await db.query('INSERT INTO mas_business_organization(id,name,created_by) VALUES($1,$2,$3)',[id(10),'Team',id(1)]);
 for(let user=1;user<=4;user++)await db.query('INSERT INTO mas_business_membership(organization_id,user_id,role) VALUES($1,$2,$3)',[id(10),id(user),user===1||user===4?'owner':'member']);
 for(const project of [20,22]){
  await db.exec('BEGIN');
  await db.query('INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id) VALUES($1,$2,$3,$4,$5)',[id(project),id(10),'Project',id(1),id(project+1)]);
  await db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(project+1),id(project),'Board']);await db.exec('COMMIT');
  for(let user=1;user<=3;user++)await db.query('INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role) VALUES($1,$2,$3,$4)',[id(project),id(10),id(user),user===1?'owner':user===2?'member':'viewer']);
 }
 await db.query("INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash,session_hash,session_until) VALUES($1,$2,'Runner',$3,$4,now()+interval '1 hour')",[id(30),id(1),hashRunnerSecret(credential),hashRunnerSecret(sessionId)]);
 await db.query("INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,name,enabled,ready_until,ready_session_hash) VALUES($1,$2,$3,'codex-code','执行者',true,now()+interval '1 hour',$4)",[id(40),id(30),id(1),hashRunnerSecret(sessionId)]);
 await db.query('INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled) VALUES($1,$2,$3,true)',[id(40),id(1),id(20)]);
 const {taskId}=await handleDirectTaskRequest(pool,owner,new Request('https://example.test/api/account/projects/'+id(20)+'/boards/'+id(21)+'/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:'Write a guide',requestId:id(100)})}));
 await db.query("INSERT INTO mas_business_work(id,task_id,kind,state,approved,result) VALUES($1,$2,'assess','done',true,$3) ON CONFLICT(task_id,kind) DO UPDATE SET state='done',approved=true,result=excluded.result",[id(50),taskId,JSON.stringify({difficulty:1,risk:'low',confidence:1,rationale:'Test',requiredCapability:'writing'})]);
 await db.query("INSERT INTO mas_business_work(id,task_id,kind,state,calls) VALUES($1,$2,'execute','active',1)",[id(51),taskId]);
 await db.query("INSERT INTO mas_business_work_attempt(id,work_id,agent_id,runner_id,owner_id,fence,state,lease_until) VALUES($1,$2,$3,$4,$5,1,'running',now()+interval '1 hour')",[id(60),id(51),id(40),id(30),id(1)]);
 await db.query("UPDATE mas_business_task SET status='running',required_capabilities=ARRAY['writing'] WHERE id=$1",[taskId]);
 const ref={taskId,attemptId:id(60),fence:1};let nextRequest=1000;
 const path=(project=id(20))=>'https://example.test/api/account/projects/'+project+'/tasks/'+taskId+'/conversation/messages';
 const read=async(actor=owner,project=id(20))=>taskInteractiveConversationResponseSchema.parse(await handleTaskReview(pool,actor,new Request(path(project))));
 const post=async(body:Record<string,unknown>,actor=owner,project=id(20))=>taskMessageReceiptSchema.parse(await handleTaskReview(pool,actor,new Request(path(project),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})));
 const send=(body:string,actor=owner,requestId=id(nextRequest++),attemptId=ref.attemptId,project=id(20))=>post({identityId:actor.id,attemptId,requestId,body},actor,project);
 const runner=(action:'messages'|'message-ack',extra:Record<string,unknown>={})=>handleExecutionRequest(pool,new Request('https://example.test/api/runner/tasks/'+action,{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(30),sessionId,ref,...extra})}),['codex-code','dsh-text']);
 const poll=async(extra:Record<string,unknown>={})=>runnerTaskMessageResponseSchema.parse(await runner('messages',extra));
 const ack=(messageId:string,outcome:'delivered'|'rejected'|'unknown'='delivered',extra:Record<string,unknown>={})=>runner('message-ack',{messageId,outcome,...extra});
 const authority=async()=>{
  const row=(await db.query<{lease_until:Date;session_until:Date;task_status:string;work_state:string;attempt_state:string;calls:number}>(`SELECT a.lease_until,d.session_until,t.status AS task_status,w.state AS work_state,a.state AS attempt_state,w.calls
   FROM mas_business_work_attempt a JOIN mas_business_work w ON w.id=a.work_id JOIN mas_business_task t ON t.id=w.task_id JOIN mas_business_runner_device d ON d.id=a.runner_id WHERE a.id=$1`,[ref.attemptId])).rows[0];
  return {...row,lease_until:row.lease_until.toISOString(),session_until:row.session_until.toISOString()};
 };
 const finish=()=>db.exec("UPDATE mas_business_work_attempt SET state='finished',finished_at=now(),lease_until=to_timestamp(0); UPDATE mas_business_work SET state='review' WHERE kind='execute'; UPDATE mas_business_task SET status='review'");
 return {db,pool,taskId,ref,path,read,post,send,poll,ack,authority,finish};
}

test('task messages require live advertisement, deliver oldest once and preserve idempotent receipts without renewing authority',async t=>{
 const f=await fixture(t);
 assert.equal(executionRoute(new Request(f.path())),true);
 assert.equal(executionRoute(new Request(f.path(),{method:'POST'})),true);
 const before=await f.authority();
 assert.equal((await f.read()).messaging.canSend,false);
 await assert.rejects(()=>f.send('还未就绪'),rejected);
 assert.deepEqual(await f.poll(),{attemptId:f.ref.attemptId,message:null});
 assert.equal((await f.read()).messaging.canSend,true);
 const requestId=id(110),first=await f.send('请补充验收步骤',member,requestId),second=await f.send('请保留已有修改');
 assert.equal(first.message.state,'queued');assert.equal(first.message.authorName,member.name);assert.equal(first.message.error,null);
 assert.equal((await f.send('请补充验收步骤',member,requestId)).message.id,first.message.id);
 await assert.rejects(()=>f.send('冲突的正文',member,requestId),error=>error===409);
 await assert.rejects(()=>f.send('请补充验收步骤',owner,requestId),error=>error===409);
 await assert.rejects(()=>f.ack(second.message.id),error=>error===409);
 const claimed=await f.poll();assert.deepEqual(claimed.message,{id:first.message.id,text:first.message.body});
 assert.deepEqual(await f.poll(),claimed,'lost poll or acknowledgement cannot claim a second message');
 assert.equal((await f.read()).messaging.messages.find(message=>message.id===first.message.id)?.state,'delivering');
 assert.deepEqual(await f.ack(first.message.id),{ok:true});assert.deepEqual(await f.ack(first.message.id),{ok:true});
 assert.deepEqual((await f.poll()).message,{id:second.message.id,text:second.message.body});
 await f.ack(second.message.id,'rejected');assert.equal((await f.poll()).message,null);
 const messages=(await f.read()).messaging.messages;
 assert.deepEqual(messages.map(message=>[message.state,message.error]),[['delivered',null],['rejected','rejected']]);
 assert.deepEqual(await f.authority(),before,'sending, claiming and acknowledging are not workflow transitions or lease renewal');
 await f.finish();
 const replay=await f.send('请补充验收步骤',member,requestId);assert.equal(replay.message.id,first.message.id);assert.equal(replay.message.body,first.message.body);
 await assert.rejects(()=>f.send('已结束不能再发'),rejected);await assert.rejects(()=>f.poll(),error=>error===409);
});

test('task message admission checks project membership, identity, board, active executor grants and session',async t=>{
 const f=await fixture(t);await f.poll();
 assert.equal((await f.read(viewer)).messaging.reason,'read_only');
 await assert.rejects(()=>f.send('只读账号不能发',viewer),error=>error===403);
 assert.equal((await f.read(organizationOwner)).messaging.canSend,false);
 await assert.rejects(()=>f.send('组织所有者没有项目写权限',organizationOwner),rejected);
 await assert.rejects(()=>f.send('跨项目',owner,id(120),f.ref.attemptId,id(22)),error=>error===404);
 await assert.rejects(()=>f.read(owner,id(22)),error=>error===404);
 await assert.rejects(()=>f.post({identityId:member.id,attemptId:f.ref.attemptId,requestId:id(121),body:'错配账号'},owner),error=>error===403);
 await assert.rejects(()=>f.send('错配轮次',owner,id(122),id(99)),error=>error===409);
 await assert.rejects(()=>f.poll({ref:{...f.ref,fence:2}}),error=>error===409);
 await assert.rejects(()=>f.poll({ref:{...f.ref,taskId:id(99)}}),error=>error===409);
 await assert.rejects(()=>f.poll({sessionId:'c'.repeat(64)}),error=>error===409);
 const toggles=[
  ["UPDATE mas_business_work_attempt SET message_ready_until=to_timestamp(0)","UPDATE mas_business_work_attempt SET message_ready_until=now()+interval '1 hour'"],
  ["UPDATE mas_business_work_attempt SET lease_until=to_timestamp(0)","UPDATE mas_business_work_attempt SET lease_until=now()+interval '1 hour'"],
  ["UPDATE mas_business_runner_device SET session_until=to_timestamp(0)","UPDATE mas_business_runner_device SET session_until=now()+interval '1 hour'"],
  ['UPDATE mas_business_agent_project SET enabled=false','UPDATE mas_business_agent_project SET enabled=true'],
  ['UPDATE mas_business_agent SET enabled=false','UPDATE mas_business_agent SET enabled=true'],
  ["UPDATE mas_business_agent SET profile='dsh-text'","UPDATE mas_business_agent SET profile='codex-code'"],
  ["UPDATE mas_business_membership SET status='suspended' WHERE user_id='"+id(1)+"'","UPDATE mas_business_membership SET status='active' WHERE user_id='"+id(1)+"'"],
  ["UPDATE mas_business_project_member SET status='suspended' WHERE user_id='"+id(1)+"'","UPDATE mas_business_project_member SET status='active' WHERE user_id='"+id(1)+"'"],
 ];
 for(const [deny,restore] of toggles){
  await f.db.exec(deny);
  assert.equal((await f.read(member)).messaging.canSend,false,deny);
  await assert.rejects(()=>f.send('权限不满足',member),rejected,deny);
  await f.db.exec(restore);
 }
 await f.db.exec('UPDATE mas_business_board SET archived_at=now()');
 await assert.rejects(()=>f.read(),error=>error===404);await assert.rejects(()=>f.send('已归档看板'),error=>error===404);
});

test('claim rechecks the sender and late acknowledgements cannot deliver across attempts or after termination',async t=>{
 const f=await fixture(t);await f.poll();
 const revoked=await f.send('撤权后不得进入 Agent',member),allowed=await f.send('仍被授权的消息');
 await f.db.query("UPDATE mas_business_project_member SET status='suspended' WHERE user_id=$1",[id(2)]);
 const claim=await f.poll();assert.deepEqual(claim.message,{id:allowed.message.id,text:allowed.message.body});
 const revokedView=(await f.read()).messaging.messages.find(message=>message.id===revoked.message.id);
 assert.equal(revokedView?.state,'rejected');assert.equal(revokedView?.error,'permission_revoked');
 const queued=await f.send('执行结束前尚未交付');
 await f.finish();
 const terminal=(await f.read()).messaging;
 assert.equal(terminal.canSend,false);
 assert.equal(terminal.messages.find(message=>message.id===allowed.message.id)?.state,'unknown');
 assert.equal(terminal.messages.find(message=>message.id===allowed.message.id)?.error,'unconfirmed');
 assert.equal(terminal.messages.find(message=>message.id===queued.message.id)?.state,'rejected');
 assert.equal(terminal.messages.find(message=>message.id===queued.message.id)?.error,'execution_ended');
 await assert.rejects(()=>f.poll(),error=>error===409);
 await assert.rejects(()=>f.ack(queued.message.id),error=>error===409);
 await assert.rejects(()=>f.ack(allowed.message.id,'delivered',{sessionId:'c'.repeat(64)}),error=>error===409);
 await assert.rejects(()=>f.ack(allowed.message.id,'delivered',{ref:{...f.ref,fence:2}}),error=>error===409);
 // A successor is active, but a delayed receipt belongs only to the original claimed message.
 await f.db.query("UPDATE mas_business_work SET state='active',calls=2 WHERE id=$1",[id(51)]);
 await f.db.query("INSERT INTO mas_business_work_attempt(id,work_id,agent_id,runner_id,owner_id,fence,state,lease_until) VALUES($1,$2,$3,$4,$5,2,'running',now()+interval '1 hour')",[id(61),id(51),id(40),id(30),id(1)]);
 await f.db.query("UPDATE mas_business_task SET status='running' WHERE id=$1",[f.taskId]);
 const nextRef={...f.ref,attemptId:id(61),fence:2};
 await assert.rejects(()=>f.ack(allowed.message.id,'delivered',{ref:nextRef}),error=>error===409);
 assert.deepEqual(await f.ack(allowed.message.id),{ok:true});assert.deepEqual(await f.ack(allowed.message.id),{ok:true});
 const stored=(await f.db.query<{state:string}>('SELECT state FROM mas_business_task_message WHERE id=$1',[allowed.message.id])).rows[0];assert.equal(stored.state,'delivered');
 assert.deepEqual(await f.poll({ref:nextRef}),{attemptId:nextRef.attemptId,message:null});
 assert.deepEqual((await f.read()).messaging.messages,[],'the successor must not replay previous attempt messages');
 await assert.rejects(()=>f.poll(),error=>error===409);
});

test('task messages enforce meaningful input and a durable fifty-message attempt limit',async t=>{
 const f=await fixture(t);await f.poll();
 for(const body of ['', '   ', '界'.repeat(2001)])await assert.rejects(()=>f.send(body),error=>!!error);
 const first=await f.send('界'.repeat(2000),owner,id(130));assert.equal(first.message.body.length,2000);
 for(let index=1;index<50;index++)await f.send('补充信息 '+index);
 const full=(await f.read()).messaging;assert.equal(full.messages.length,50);assert.equal(full.canSend,false);assert.equal(full.reason,'limit');
 assert.equal((await f.send('界'.repeat(2000),owner,id(130))).message.id,first.message.id,'replay does not consume another slot');
 await assert.rejects(()=>f.send('超过上限'),rejected);
 await f.poll();await f.ack(first.message.id);
 assert.equal((await f.read()).messaging.messages.length,50);
 await assert.rejects(()=>f.send('已交付仍然占本轮总额'),rejected);
});

test('sender authorization lock contention rolls back the claim and remains retryable',async t=>{
 let contention=false,lockAttempts=0;
 // PGlite uses one connection: inject PostgreSQL's NOWAIT failure at the
 // authorization query boundary; this checks rollback, not real concurrency.
 const f=await fixture(t,sql=>{
  if(contention&&sql.includes('mas_business_user')&&/FOR SHARE[\s\S]*NOWAIT/i.test(sql)){
   lockAttempts++;throw Object.assign(new Error('simulated authorization row contention'),{code:'55P03'});
  }
 });
 await f.poll();const sent=await f.send('等待成员权限变更结束',member);
 const before=await f.authority();
 const readyUntil=async()=>(await f.db.query<{message_ready_until:Date}>('SELECT message_ready_until FROM mas_business_work_attempt WHERE id=$1',[f.ref.attemptId])).rows[0].message_ready_until.toISOString();
 const readyBefore=await readyUntil();
 contention=true;await assert.rejects(()=>f.poll(),error=>error===503);
 assert.equal(lockAttempts,1,'claim must lock the message author authorization rows without waiting');
 assert.deepEqual(await f.authority(),before);assert.equal(await readyUntil(),readyBefore);
 const stored=(await f.db.query<{state:string;claimed_at:Date|null}>('SELECT state,claimed_at FROM mas_business_task_message WHERE id=$1',[sent.message.id])).rows[0];
 assert.deepEqual(stored,{state:'queued',claimed_at:null});
 contention=false;
 assert.deepEqual((await f.poll()).message,{id:sent.message.id,text:sent.message.body});
 await f.ack(sent.message.id);
 assert.equal((await f.read()).messaging.messages[0].state,'delivered');
});
