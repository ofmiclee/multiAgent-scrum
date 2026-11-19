import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test,{type TestContext} from 'node:test';
import {TaskWorker} from '../services/runner/task-worker.ts';
import {TaskJournal} from '../services/runner/task-journal.ts';
import {terminalSchema} from '../packages/domain/runner-protocol.ts';
import {ExecutorStopUnconfirmed,ExecutorTimeout} from '../packages/domain/execution-errors.ts';

async function fixture(t:TestContext,error:Error|'cancel',status=200){
  const root=await mkdtemp(join(tmpdir(),'mas-worker-failure-')),ref={taskId:'task',attemptId:'attempt',fence:1};
  const requests:{action:string;body:any}[]=[];
  let offered=false;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),action=req.url!.split('/').at(-1)!;requests.push({action,body});
    res.setHeader('content-type','application/json');let value:unknown={ok:true};
    if(action==='poll'){value=offered?null:ref;offered=true;}
    if(action==='start')value={...ref,title:'Task',description:'',acceptance:'',feedback:[]};
    if(action==='renew')value={action:'continue'};
    if(action==='stopped'&&body.reason)res.statusCode=status;
    res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const journal=new TaskJournal(root),worker=new TaskWorker({server:`http://127.0.0.1:${address.port}`,identity:{version:1,runnerId:'runner',credential:'test'},journal,executor:{run:async(_input,signal)=>{
    if(error==='cancel')return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('private cancellation detail')),{once:true}));
    throw error;
  }}});
  t.after(async()=>{await worker.stop().catch(()=>{});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
  await worker.step('session');
  // Wait for the existing async journal write, rather than advancing another lease.
  for(let index=0;index<100&&error!=='cancel'&&!(error instanceof ExecutorStopUnconfirmed);index++){
    if((await journal.pending())[0]?.terminal)break;
    await delay(5);
  }
  await delay(25);
  return {worker,journal,requests};
}

test('ordinary execution errors persist and send only a safe category',async t=>{
  const secret='sk-private-value /private/user/file',f=await fixture(t,Error(secret));
  assert.deepEqual((await f.journal.pending())[0]?.terminal,{kind:'stopped',reason:'execution_failed'});
  await f.worker.step('session');
  const stopped=f.requests.find(row=>row.action==='stopped');
  assert.equal(stopped?.body.reason,'execution_failed');
  assert.ok(!JSON.stringify(f.requests).includes(secret));
  assert.deepEqual(await f.journal.pending(),[]);
});

test('typed executor timeouts retain their category in the journal and receipt',async t=>{
  const f=await fixture(t,new ExecutorTimeout());
  assert.deepEqual((await f.journal.pending())[0]?.terminal,{kind:'stopped',reason:'timeout'});
  await f.worker.step('session');
  assert.equal(f.requests.find(row=>row.action==='stopped')?.body.reason,'timeout');
});

test('intentional abort stays a generic stopped receipt without a failure category',async t=>{
  const f=await fixture(t,'cancel');
  await f.worker.stop('session');
  const stopped=f.requests.filter(row=>row.action==='stopped');
  assert.equal(stopped.length,1);assert.equal(stopped[0].body.reason,undefined);
  assert.ok(!JSON.stringify(stopped).includes('private cancellation detail'));
  assert.deepEqual(await f.journal.pending(),[]);
});

test('old servers rejecting the optional reason receive the legacy stop receipt',async t=>{
  const f=await fixture(t,Error('private native failure'),400);
  await f.worker.step('session');
  assert.deepEqual(f.requests.filter(row=>row.action==='stopped').map(row=>row.body.reason),['execution_failed',undefined]);
  assert.deepEqual(await f.journal.pending(),[]);
});

for(const status of [401,403,409,500])test(`stop reason does not bypass HTTP ${status}`,async t=>{
  const f=await fixture(t,Error('failure'),status);
  await assert.rejects(f.worker.step('session'));
  assert.equal(f.requests.filter(row=>row.action==='stopped').length,1);
  assert.equal((await f.journal.pending()).length,1);
});

test('stop-unconfirmed failures remain quarantined without a false stop receipt',async t=>{
  const f=await fixture(t,new ExecutorStopUnconfirmed());
  assert.equal((await f.journal.pending())[0]?.terminal,undefined);
  await assert.rejects(f.worker.step('session'),/Unfinished task journal/);
  assert.equal(f.requests.filter(row=>row.action==='stopped').length,0);
});

test('journal stop reasons are optional and strictly whitelisted',()=>{
  assert.deepEqual(terminalSchema.parse({kind:'stopped'}),{kind:'stopped'});
  assert.deepEqual(terminalSchema.parse({kind:'stopped',reason:'timeout'}),{kind:'stopped',reason:'timeout'});
  assert.equal(terminalSchema.safeParse({kind:'stopped',reason:'private error text'}).success,false);
});
