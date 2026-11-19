import assert from 'node:assert/strict';
import {mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {CodexExecutor,readCodexAccount} from '../packages/executors/codex.ts';
import type {ExecutionInput} from '../packages/domain/contracts.ts';
const realSetTimeout=globalThis.setTimeout;

async function fixture(t:TestContext){
  const cwd=await realpath(await mkdtemp(join(tmpdir(),'mas-codex-timeout-'))),script=join(cwd,'fixture.mjs');
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  await writeFile(script,`import {createInterface} from 'node:readline';
import {writeFileSync} from 'node:fs';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),reply=result=>emit({id:m.id,result});
 if(m.method==='initialize')reply({});
 if(m.method==='thread/start')reply({thread:{id:'thread'},cwd:process.cwd(),approvalPolicy:'never',sandbox:{type:m.params.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false,writableRoots:[]}});
 if(m.method==='turn/start'){reply({turn:{id:'turn'}});writeFileSync(${JSON.stringify(join(cwd,'ready'))},String(process.pid));}
 if(m.method==='account/read')writeFileSync(${JSON.stringify(join(cwd,'ready'))},String(process.pid));
});`);
  return {command:process.execPath,args:[script],cwd};
}
const input=(cwd:string):ExecutionInput=>({taskId:'task',attemptId:'attempt',fence:1,title:'Task',description:'',acceptance:'',feedback:[],cwd});
async function ready(cwd:string){
  const deadline=performance.now()+3000;
  while(performance.now()<deadline){
    try{const pid=Number(await readFile(join(cwd,'ready'),'utf8'));if(pid>0)return pid;}catch{}
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  throw Error('Fixture did not start a native turn');
}
const timedOut=(error:unknown)=>error instanceof Error&&error.name==='ExecutorTimeout';

test('explicit Codex execution timeout terminates the real child and has a safe category',async t=>{
  const f=await fixture(t),controller=new AbortController();
  const running=new CodexExecutor({...f,timeoutMs:500}).run(input(f.cwd),controller.signal);
  t.after(async()=>{controller.abort();await running.catch(()=>{});});
  const rejected=assert.rejects(running,timedOut),pid=await ready(f.cwd);
  await rejected;
  assert.throws(()=>process.kill(pid,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ESRCH');
});

test('execution survives ten minutes and stops at its one-hour default',async t=>{
  const f=await fixture(t),controller=new AbortController();
  t.mock.timers.enable({apis:['setTimeout']});
  const running=new CodexExecutor(f).run(input(f.cwd),controller.signal);
  let failure:unknown;void running.catch(error=>{failure=error;});
  t.after(async()=>{controller.abort();t.mock.timers.reset();await running.catch(()=>{});});
  await ready(f.cwd);
  t.mock.timers.tick(10*60_000);
  await new Promise<void>(resolve=>realSetTimeout(resolve,50));
  assert.equal(failure,undefined,'code execution must remain active after ten minutes');
  t.mock.timers.tick(50*60_000);
  await assert.rejects(running,timedOut);
});

for(const purpose of ['assess','decompose'] as const)test(`${purpose} retains the ten-minute bound`,async t=>{
  const f=await fixture(t),controller=new AbortController();
  t.mock.timers.enable({apis:['setTimeout']});
  const running=new CodexExecutor(f).run({...input(f.cwd),purpose},controller.signal);
  void running.catch(()=>{});
  t.after(async()=>{controller.abort();t.mock.timers.reset();await running.catch(()=>{});});
  await ready(f.cwd);t.mock.timers.tick(10*60_000);
  await assert.rejects(running,timedOut);
});

test('account metadata retains its eight-second timeout',async t=>{
  const f=await fixture(t);
  t.mock.timers.enable({apis:['setTimeout']});
  const running=readCodexAccount(f);void running.catch(()=>{});
  t.after(()=>t.mock.timers.reset());
  await ready(f.cwd);t.mock.timers.tick(8000);
  await assert.rejects(running,timedOut);
});
