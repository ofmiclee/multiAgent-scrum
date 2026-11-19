import assert from 'node:assert/strict';
import {createServer,type ServerResponse} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test,{type TestContext} from 'node:test';
import {TaskWorker} from '../services/runner/task-worker.ts';
import {TaskJournal} from '../services/runner/task-journal.ts';
import type {ExecutionInput,ExecutionMessageHandler,ExecutionResult} from '../packages/domain/contracts.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function fixture(t:TestContext,options:{hold?:boolean;foreign?:boolean;ackFail?:boolean;noHook?:boolean;messageStatus?:number;handler?:ExecutionMessageHandler}={}){
 const root=await mkdtemp(join(tmpdir(),'mas-worker-message-')),ref={taskId:id(1),attemptId:id(2),fence:1};
 const requests:{action:string;body:any}[]=[],held:ServerResponse[]=[],calls:string[]=[];
 let input!:ExecutionInput,complete!:(value:ExecutionResult)=>void,offered=false,ackFailed=false;
 const server=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const action=req.url!.split('/').at(-1)!;requests.push({action,body:JSON.parse(body)});
  res.setHeader('content-type','application/json');let value:unknown={ok:true};
  if(action==='poll'){value=offered?null:ref;offered=true;}
  if(action==='start')value={...ref,title:'Task',description:'',acceptance:'',feedback:[]};
  if(action==='renew')value={action:'continue'};
  if(action==='messages'){
   if(options.messageStatus)res.statusCode=options.messageStatus;
   if(options.hold){held.push(res);return;}
   value={attemptId:options.foreign?id(9):ref.attemptId,message:{id:id(3),text:'补充要求'}};
  }
  if(action==='message-ack'&&options.ackFail&&!ackFailed){res.statusCode=503;ackFailed=true;}
  res.end(JSON.stringify(value));
 });
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const addr=server.address();assert.ok(addr&&typeof addr!=='string');
 const worker=new TaskWorker({server:`http://127.0.0.1:${addr.port}`,identity:{version:1,runnerId:id(4),credential:'test'},journal:new TaskJournal(root),executor:{run:async value=>{
  input=value;if(!options.noHook)value.onMessageReady?.(async message=>{calls.push(message.id);return options.handler?options.handler(message):'delivered';});
  return new Promise<ExecutionResult>(resolve=>{complete=resolve;});
 }}});
 t.after(async()=>{complete?.({summary:'完成',artifacts:[],checksPassed:false});for(const response of held)response.end(JSON.stringify({attemptId:ref.attemptId,message:null}));await worker.stop();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});});
 await worker.step('session');await delay(30);
 return {worker,input,complete,requests,calls,held,ref};
}
test('message ACK retries never repeat native delivery, even if the server offers the same id again',async t=>{
 const f=await fixture(t,{ackFail:true});
 await f.worker.step('session');await delay(30);
 await f.worker.step('session');await delay(30);
 await f.worker.step('session');await delay(30);
 assert.deepEqual(f.calls,[id(3)]);
 const acks=f.requests.filter(r=>r.action==='message-ack');assert.ok(acks.length>=2);
 assert.ok(acks.every(r=>r.body.messageId===id(3)&&r.body.outcome==='delivered'));
 assert.ok(f.requests.filter(r=>r.action==='renew').length>=3);
});
test('a slow native message cannot delay renewal or final result upload',async t=>{
 const f=await fixture(t,{handler:()=>new Promise(()=>{})});
 await Promise.race([f.worker.step('session'),delay(200).then(()=>{throw Error('message blocked renewal');})]);
 f.complete({summary:'完成',artifacts:[],checksPassed:false});
 // Keep driving the connection loop while the terminal journal write completes.
 const finishDeadline=performance.now()+1300;
 do{
  await f.worker.step('session');
  if(f.requests.some(r=>r.action==='finish'))break;
  await delay(5);
 }while(performance.now()<finishDeadline);
 assert.ok(performance.now()<finishDeadline,'message blocked finish');
 assert.ok(f.requests.some(r=>r.action==='finish'));
 assert.deepEqual(f.calls,[id(3)]);
 assert.equal(f.requests.find(r=>r.action==='message-ack')?.body.outcome,'unknown');
});
test('foreign attempts and unavailable hooks never deliver a message',async t=>{
 const foreign=await fixture(t,{foreign:true});assert.deepEqual(foreign.calls,[]);
 const unsupported=await fixture(t,{noHook:true});assert.equal(unsupported.requests.filter(r=>r.action==='messages').length,0);
 const late=await fixture(t,{hold:true});assert.equal(late.held.length,1);
 late.input.onMessageReady?.(null);
 late.held[0].end(JSON.stringify({attemptId:late.ref.attemptId,message:{id:id(3),text:'late'}}));await delay(30);
 assert.deepEqual(late.calls,[]);
 assert.equal(late.requests.find(r=>r.action==='message-ack')?.body.outcome,'rejected');
});

test('old-server message endpoint rejection disables only the message channel',async t=>{
 const f=await fixture(t,{messageStatus:404});
 await f.worker.step('session');await delay(30);await f.worker.step('session');await delay(30);
 assert.equal(f.requests.filter(r=>r.action==='messages').length,1);
 assert.equal(f.requests.filter(r=>r.action==='renew').length,2);
 assert.deepEqual(f.calls,[]);
});
