import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer,request as httpRequest} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import {handleExecutionRequest,handleTaskReview} from '../services/account/execution-routes.ts';
import {hashRunnerSecret} from '../services/account/runner-connections.ts';
import {handleDirectTaskRequest} from '../services/account/direct-tasks.ts';
import {conversationSnapshotSchema,taskConversationResponseSchema} from '../packages/domain/task-conversation.ts';
import {createAccountWebHandler} from '../services/account/web.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const principal={id:'owner',name:'Owner'},credential='a'.repeat(64),sessionId='b'.repeat(64);
const snapshot=(revision=1,text='正在检查任务')=>({revision,entries:[{id:'message-1',kind:'message',text,state:'completed',at:1}],truncated:false});
test('task conversation is bounded, fenced, project-scoped and independent of workflow authority',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
 const pool={connect:async()=>({query:async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};},release(){}})} as unknown as Pool;
 await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',[principal.id,principal.name,'owner@example.test']);
 await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(1),principal.id,principal.name]);
 await db.query('INSERT INTO mas_business_organization(id,name,created_by) VALUES($1,$2,$3)',[id(10),'Team',id(1)]);
 await db.query("INSERT INTO mas_business_membership(organization_id,user_id,role) VALUES($1,$2,'owner')",[id(10),id(1)]);
 await db.query("INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash,session_hash,session_until) VALUES($1,$2,'Runner',$3,$4,now()+interval '1 hour')",[id(30),id(1),hashRunnerSecret(credential),hashRunnerSecret(sessionId)]);
 await db.query("INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,name,enabled,ready_until,ready_session_hash) VALUES($1,$2,$3,'dsh-text','执行者',true,to_timestamp(0),$4)",[id(40),id(30),id(1),hashRunnerSecret(sessionId)]);
 for(const project of [20,22]){
  await db.exec('BEGIN');
  await db.query('INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id) VALUES($1,$2,$3,$4,$5)',[id(project),id(10),'Project',id(1),id(project+1)]);
  await db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(project+1),id(project),'Board']);await db.exec('COMMIT');
  await db.query("INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",[id(project),id(10),id(1)]);
 }
 await db.query('INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled) VALUES($1,$2,$3,true)',[id(40),id(1),id(20)]);
 const {taskId}=await handleDirectTaskRequest(pool,principal,new Request('https://example.test/api/account/projects/'+id(20)+'/boards/'+id(21)+'/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:'Write a guide',requestId:id(100)})}));
 const read=(project=id(20),actor=principal)=>handleTaskReview(pool,actor,new Request('https://example.test/api/account/projects/'+project+'/tasks/'+taskId+'/conversation'));
 const empty=taskConversationResponseSchema.parse(await read());assert.equal(empty.attempt,null);
 await db.query("INSERT INTO mas_business_work(id,task_id,kind,state,approved,result) VALUES($1,$2,'assess','done',true,$3) ON CONFLICT(task_id,kind) DO UPDATE SET state='done',approved=true,result=excluded.result",[id(50),taskId,JSON.stringify({difficulty:1,risk:'low',confidence:1,rationale:'Test',requiredCapability:'writing'})]);
 await db.query("INSERT INTO mas_business_work(id,task_id,kind,state,calls) VALUES($1,$2,'execute','active',1)",[id(51),taskId]);
 await db.query("INSERT INTO mas_business_work_attempt(id,work_id,agent_id,runner_id,owner_id,fence,state,lease_until) VALUES($1,$2,$3,$4,$5,1,'running',now()+interval '1 hour')",[id(60),id(51),id(40),id(30),id(1)]);
 await db.query("UPDATE mas_business_task SET status='running',required_capabilities=ARRAY['writing'] WHERE id=$1",[taskId]);
 const ref={taskId,attemptId:id(60),fence:1};
 const progress=(value:unknown,overrides={})=>handleExecutionRequest(pool,new Request('https://example.test/api/runner/tasks/progress',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(30),sessionId,ref,snapshot:value,...overrides})}),['dsh-text']);
 const lease=(await db.query<{lease_until:Date}>('SELECT lease_until FROM mas_business_work_attempt WHERE id=$1',[id(60)])).rows[0].lease_until;
 assert.deepEqual(await progress(snapshot(2)),{ok:true});
 let value=taskConversationResponseSchema.parse(await read());assert.equal(value.attempt?.snapshot?.revision,2);assert.equal(value.attempt?.live,true);
 await progress(snapshot(1,'old'));await progress(snapshot(2,'duplicate'));
 value=taskConversationResponseSchema.parse(await read());assert.equal(value.attempt?.snapshot?.entries[0].text,'正在检查任务');
 assert.equal((await db.query<{lease_until:Date}>('SELECT lease_until FROM mas_business_work_attempt WHERE id=$1',[id(60)])).rows[0].lease_until.getTime(),lease.getTime());
 assert.equal(value.taskStatus,'running');
 await progress(snapshot(3,'状态：Bearer private-test-credential'));
 assert.equal(JSON.stringify(await read()).includes('private-test-credential'),false);
 await assert.rejects(()=>progress(snapshot(4),{ref:{...ref,fence:2}}),e=>e===409);
 await assert.rejects(()=>progress(snapshot(4),{sessionId:'c'.repeat(64)}),e=>e===409);
 await assert.rejects(()=>read(id(22)),e=>e===404);
 await assert.rejects(()=>read(id(20),{id:'stranger',name:'Other'}),e=>e===404);
 for(const [table,column,denied,restore] of [
  ['mas_business_work_attempt','lease_until','to_timestamp(0)',"now()+interval '1 hour'"],
  ['mas_business_agent_project','enabled','false','true'],
  ['mas_business_membership','status',"'suspended'","'active'"],
 ] as const){
  await db.exec(`UPDATE ${table} SET ${column}=${denied}`);
  await assert.rejects(()=>progress(snapshot(4)),e=>e===403||e===404||e===409);
  await db.exec(`UPDATE ${table} SET ${column}=${restore}`);
 }
 await db.exec("UPDATE mas_business_work_attempt SET state='finished',finished_at=now(); UPDATE mas_business_work SET state='review' WHERE kind='execute'; UPDATE mas_business_task SET status='review'");
 value=taskConversationResponseSchema.parse(await read());assert.equal(value.attempt?.live,false);assert.equal(value.attempt?.snapshot?.revision,3);assert.equal(value.taskStatus,'review');
 await assert.rejects(()=>progress(snapshot(4)),e=>e===409);
 await db.query('UPDATE mas_business_work_attempt SET report=$1',[JSON.stringify({summary:'最终答复',checksPassed:false,artifacts:[]})]);
 value=taskConversationResponseSchema.parse(await read());assert.equal(value.attempt?.snapshot?.entries.at(-1)?.text,'最终答复');assert.equal(value.attempt?.snapshot?.revision,4);
 await db.query('UPDATE mas_business_work_attempt SET conversation_snapshot=$1',[JSON.stringify({revision:1,entries:[],truncated:false})]);
 value=taskConversationResponseSchema.parse(await read());assert.equal(value.attempt?.snapshot?.entries.at(-1)?.text,'最终答复');
 await db.exec('UPDATE mas_business_board SET archived_at=now()');await assert.rejects(()=>read(),e=>e===404);
});

test('native HTTP intake permits bounded progress while preserving other endpoint limits',async()=>{
 const server=createServer();
 try{
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin='http://127.0.0.1:'+address.port;
  server.on('request',createAccountWebHandler({handle:async request=>new Response(JSON.stringify({bytes:(await request.text()).length}))},origin,'.'));
  function post(path:string,bytes:number){return new Promise<number>((resolve,reject)=>{
   const request=httpRequest(origin+path,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':bytes}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode!));});
   request.on('error',reject);request.end(' '.repeat(bytes));
  });}
  assert.equal(await post('/api/runner/tasks/progress',48000),200);
  assert.equal(await post('/api/runner/tasks/progress',52000),413);
  assert.equal(await post('/api/runner/tasks/renew',48000),413);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('conversation schema rejects private fields and enforces UTF-8 transport bounds',()=>{
 assert.equal(conversationSnapshotSchema.safeParse({...snapshot(),reasoning:'hidden'}).success,false);
 assert.equal(conversationSnapshotSchema.safeParse({...snapshot(),entries:Array.from({length:81},()=>snapshot().entries[0])}).success,false);
 assert.equal(conversationSnapshotSchema.safeParse({...snapshot(),entries:Array.from({length:10},(_,i)=>({...snapshot().entries[0],id:String(i),text:'中'.repeat(4000)}))}).success,false);
 assert.equal(conversationSnapshotSchema.safeParse({...snapshot(),entries:[{...snapshot().entries[0],kind:'reasoning'}]}).success,false);
});
