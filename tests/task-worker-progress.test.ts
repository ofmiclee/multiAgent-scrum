import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test,{type TestContext} from 'node:test';
import type {ExecutionInput,ExecutionResult} from '../packages/domain/contracts.ts';
import {TaskWorker} from '../services/runner/task-worker.ts';
import {TaskJournal} from '../services/runner/task-journal.ts';

async function fixture(t:TestContext,options:{purpose?:'assess';progressStatus?:number;hold?:boolean}={}){
  const root=await mkdtemp(join(tmpdir(),'mas-task-progress-'));
  const requests:{action:string;body:any}[]=[],held:ServerResponse[]=[];
  const ref={taskId:'task',attemptId:'attempt',fence:1};
  let execution:ExecutionInput|undefined,complete!:(value:ExecutionResult)=>void,offered=false;
  const server=createServer(async(req,res)=>{
    let text='';for await(const chunk of req)text+=chunk;
    const body=JSON.parse(text),action=req.url!.split('/').at(-1)!;
    requests.push({action,body});res.setHeader('content-type','application/json');
    if(action==='progress'&&options.hold){held.push(res);return;}
    if(action==='progress'&&options.progressStatus)res.statusCode=options.progressStatus;
    let result:unknown={ok:true};
    if(action==='poll'){result=offered?null:ref;offered=true;}
    if(action==='start')result={...ref,title:'Task',description:'',acceptance:'',feedback:[],...(options.purpose?{purpose:options.purpose}:{})};
    if(action==='renew')result={action:'continue'};
    res.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const worker=new TaskWorker({server:`http://127.0.0.1:${address.port}`,identity:{version:1,runnerId:'runner',credential:'test-credential'},journal:new TaskJournal(root),executor:{run:async input=>{execution=input;return new Promise<ExecutionResult>(resolve=>{complete=resolve;});}}});
  t.after(async()=>{complete?.({summary:'完成',artifacts:[],checksPassed:false});for(const res of held)res.end('{"ok":true}');await worker.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  await worker.step('session');
  return {worker,requests,held,execution:execution!,complete};
}
async function settle(){await delay(25);}

test('worker uploads bounded redacted per-attempt snapshots, updates ids, and flushes before result',async t=>{
  const f=await fixture(t);
  await settle();
  const start=f.requests.find(r=>r.action==='progress');
  assert.ok(start,'execution advertises progress support before any event');
  assert.deepEqual(start.body.snapshot,{revision:1,entries:[],truncated:false});
  assert.equal(typeof f.execution.onProgress,'function');
  f.execution.onProgress!({id:'note',kind:'message',text:'api_key=private-token',state:'completed'});
  f.execution.onProgress!({id:'tool',kind:'tool',text:'执行命令',state:'running'});
  f.execution.onProgress!({id:'tool',kind:'tool',text:'执行命令',state:'completed'});
  await f.worker.step('session');await settle();
  let snapshot=f.requests.filter(r=>r.action==='progress').at(-1)!.body.snapshot;
  assert.equal(snapshot.entries.length,2);
  assert.equal(snapshot.entries[1].state,'completed');
  assert.ok(!JSON.stringify(snapshot).includes('private-token'));
  f.execution.onProgress!({id:'key',kind:'message',text:'公开说明'.repeat(990)+'-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----',state:'completed'});
  await f.worker.step('session');await settle();
  snapshot=f.requests.filter(r=>r.action==='progress').at(-1)!.body.snapshot;
  assert.ok(!JSON.stringify(snapshot).includes('private-body'));
  assert.ok(snapshot.entries.at(-1).text.includes('[REDACTED PRIVATE KEY]'));
  for(let index=0;index<100;index++)f.execution.onProgress!({id:'short-'+index,kind:'message',text:'公开进度',state:'completed'});
  await f.worker.step('session');await settle();
  snapshot=f.requests.filter(r=>r.action==='progress').at(-1)!.body.snapshot;
  assert.equal(snapshot.entries.length,80);assert.equal(snapshot.entries[0].id,'short-20');
  for(let index=0;index<100;index++)f.execution.onProgress!({id:'entry-'+index,kind:'message',text:'界'.repeat(4000),state:'completed'});
  f.complete({summary:'完成',artifacts:[],checksPassed:false});
  // Completion becomes uploadable only after the journal's durable write.
  const finishDeadline=performance.now()+1300;
  do{
    await f.worker.step('session');
    if(f.requests.some(r=>r.action==='finish'))break;
    await delay(5);
  }while(performance.now()<finishDeadline);
  assert.ok(performance.now()<finishDeadline,'progress blocked finish');
  const progress=f.requests.filter(r=>r.action==='progress');snapshot=progress.at(-1)!.body.snapshot;
  assert.ok(snapshot.truncated);assert.ok(snapshot.entries.length<=80);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=48*1024);
  assert.equal(snapshot.entries.at(-1).id,'entry-99');
  assert.ok(f.requests.findIndex(r=>r.action==='finish')>f.requests.lastIndexOf(progress.at(-1)!));
});

test('slow telemetry is single-flight and cannot delay lease renewal or stop execution',async t=>{
  const f=await fixture(t,{hold:true});await settle();
  assert.equal(f.held.length,1);
  f.execution.onProgress!({id:'note',kind:'message',text:'公开进度',state:'completed'});
  await Promise.race([f.worker.step('session'),delay(200).then(()=>{throw Error('progress blocked renewal');})]);
  await f.worker.step('session');
  assert.equal(f.requests.filter(r=>r.action==='progress').length,1);
  assert.equal(f.requests.filter(r=>r.action==='renew').length,2);
});

test('old-server progress rejection is isolated and coordination sends no telemetry',async t=>{
  const f=await fixture(t,{progressStatus:404});await settle();
  f.execution.onProgress!({id:'note',kind:'message',text:'公开进度',state:'completed'});
  await f.worker.step('session');await settle();
  assert.equal(f.requests.filter(r=>r.action==='progress').length,1);
  assert.equal(f.requests.filter(r=>r.action==='renew').length,1);
  const assessment=await fixture(t,{purpose:'assess'});await settle();
  assert.equal(assessment.execution.onProgress,undefined);
  assert.equal(assessment.requests.filter(r=>r.action==='progress').length,0);
});
