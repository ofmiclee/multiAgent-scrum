import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {CodexExecutor} from '../packages/executors/codex.ts';
import type {ExecutionInput,ExecutionMessageHandler} from '../packages/domain/contracts.ts';

async function fixture(t:TestContext,mode='normal'){
  const cwd=await realpath(await mkdtemp(join(tmpdir(),'mas-codex-steer-')));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const script=join(cwd,'fixture.mjs');
  await writeFile(script,`import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
const done=()=>emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),reply=result=>emit({id:m.id,result});
 appendFileSync('requests',JSON.stringify(m)+'\\n');
 if(m.method==='initialize')reply({});
 if(m.method==='thread/start')reply({thread:{id:'thread'},cwd:process.cwd(),approvalPolicy:'never',sandbox:{type:m.params.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false,writableRoots:[]}});
 if(m.method==='turn/start'){if(${JSON.stringify(mode)}==='early')done();reply({turn:{id:'turn'}});if(${JSON.stringify(mode)}!=='hang')setTimeout(done,200);}
 if(m.method==='turn/steer'){
  if(m.params.input[0].text==='reject'){emit({id:m.id,error:{code:-32602,message:'private native error'}});return;}
  if(${JSON.stringify(mode)}==='hang')return;
  if(${JSON.stringify(mode)}==='silent'){setTimeout(done,20);return;}
  reply({turnId:${JSON.stringify(mode)}==='mismatch'?'other':'turn'});
  setTimeout(done,30);
 }
});`);
  return {command:process.execPath,args:[script],cwd};
}
const input=(cwd:string):ExecutionInput=>({taskId:'task',attemptId:'attempt',fence:1,title:'Task',description:'',acceptance:'',feedback:[],cwd});
const message={id:'00000000-0000-4000-8000-000000000001',text:'补充验收要求'};

test('Codex steers only the existing turn, deduplicates messages and clears the handler after completion',async t=>{
  const f=await fixture(t),hooks:(ExecutionMessageHandler|null)[]=[];
  let ready!:(handler:ExecutionMessageHandler)=>void;
  const available=new Promise<ExecutionMessageHandler>(resolve=>{ready=resolve;});
  const running=new CodexExecutor(f).run({...input(f.cwd),onMessageReady:handler=>{hooks.push(handler);if(handler)ready(handler);}},new AbortController().signal);
  const handler=await Promise.race([available,running.then(()=>{throw Error('message hook was not registered');})]);
  assert.deepEqual(await Promise.all([handler(message),handler(message)]),['delivered','delivered']);
  await running;
  assert.equal(hooks.at(-1),null);
  assert.equal(await handler({...message,id:'00000000-0000-4000-8000-000000000002'}),'rejected');
  const requests=(await readFile(join(f.cwd,'requests'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  const steer=requests.filter(row=>row.method==='turn/steer');assert.equal(steer.length,1);
  assert.deepEqual(steer[0].params,{threadId:'thread',expectedTurnId:'turn',clientUserMessageId:message.id,input:[{type:'text',text:message.text,text_elements:[]}]});
  assert.equal(requests.filter(row=>row.method==='turn/start').length,1);
  assert.equal(requests.filter(row=>row.method==='thread/resume').length,0);
});

test('native steering rejection does not fail the current execution',async t=>{
  const f=await fixture(t);let ready!:(handler:ExecutionMessageHandler)=>void;
  const available=new Promise<ExecutionMessageHandler>(resolve=>{ready=resolve;});
  const running=new CodexExecutor(f).run({...input(f.cwd),onMessageReady:handler=>{if(handler)ready(handler);}},new AbortController().signal);
  const handler=await Promise.race([available,running.then(()=>{throw Error('message hook was not registered');})]);
  assert.equal(await handler({...message,text:'reject'}),'rejected');
  assert.equal(await handler({...message,id:'00000000-0000-4000-8000-000000000002'}),'delivered');
  await running;
});

for(const mode of ['silent','mismatch'])test('Codex treats '+mode+' native receipt as unknown without restarting execution',async t=>{
  const f=await fixture(t,mode);let ready!:(handler:ExecutionMessageHandler)=>void;
  const available=new Promise<ExecutionMessageHandler>(resolve=>{ready=resolve;});
  const running=new CodexExecutor(f).run({...input(f.cwd),onMessageReady:handler=>{if(handler)ready(handler);}},new AbortController().signal);
  const receipt=(await Promise.race([available,running.then(()=>{throw Error('message hook was not registered');})]))(message);
  await running;assert.equal(await receipt,'unknown');
});

test('already completed turns and coordination never advertise a message handler',async t=>{
  for(const purpose of [undefined,'assess'] as const){
    const f=await fixture(t,'early'),handlers:(ExecutionMessageHandler|null)[]=[];
    await new CodexExecutor(f).run({...input(f.cwd),purpose,onMessageReady:handler=>handlers.push(handler)},new AbortController().signal);
    assert.ok(handlers.every(handler=>handler===null));
  }
});

test('Codex steering times out as unknown and never resends the same message',async t=>{
  const f=await fixture(t,'hang'),controller=new AbortController();let ready!:(handler:ExecutionMessageHandler)=>void;
  const available=new Promise<ExecutionMessageHandler>(resolve=>{ready=resolve;});
  const running=new CodexExecutor(f).run({...input(f.cwd),onMessageReady:handler=>{if(handler)ready(handler);}},controller.signal);
  void running.catch(()=>{});t.after(async()=>{controller.abort();await running.catch(()=>{});});
  const handler=await available,start=Date.now();
  assert.equal(await handler(message),'unknown');
  assert.ok(Date.now()-start<6000);
  assert.equal(await handler(message),'unknown');
  const requests=(await readFile(join(f.cwd,'requests'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(requests.filter(row=>row.method==='turn/steer').length,1);
});
