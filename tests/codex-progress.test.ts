import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {CodexExecutor} from '../packages/executors/codex.ts';
import type {ExecutionInput} from '../packages/domain/contracts.ts';

async function fixture(t:TestContext,message='正在检查实现'){
  const cwd=await realpath(await mkdtemp(join(tmpdir(),'mas-codex-progress-')));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const command=join(cwd,'codex-fixture.mjs');
  await writeFile(command,`#!${process.execPath}
import {createInterface} from 'node:readline';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),reply=result=>emit({id:m.id,result});
 const event=(method,item,threadId='thread',turnId='turn')=>emit({method,params:{threadId,turnId,item}});
 if(m.method==='initialize')reply({});
 if(m.method==='thread/start')reply({thread:{id:'thread'},cwd:process.cwd(),approvalPolicy:'never',sandbox:{type:m.params.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false,writableRoots:[]}});
 if(m.method==='turn/start'){
  event('item/completed',{id:'foreign',type:'agentMessage',text:'foreign thread'},'other');
  event('item/completed',{id:'old',type:'agentMessage',text:'foreign turn'},'thread','old');
  event('item/completed',{id:'private',type:'reasoning',text:'private reasoning'});
  event('item/completed',{id:'analysis',type:'agentMessage',phase:'analysis',text:'private analysis'});
  event('item/completed',{id:'note',type:'agentMessage',phase:'commentary',text:${JSON.stringify(message)}});
  event('item/started',{id:'tool',type:'commandExecution',command:'password=private-value',aggregatedOutput:'private output'});
  reply({turn:{id:'turn'}});
  event('item/completed',{id:'tool',type:'commandExecution',status:'failed',exitCode:1,command:'private command',aggregatedOutput:'private output'});
  event('item/completed',{id:'unknown',type:'futureTool',text:'private unknown payload'});
  event('item/completed',{id:'final',type:'agentMessage',phase:'final',text:'检查完成'});
  emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed'}}});
 }
});
`,{mode:0o700});
  return {command:process.execPath,args:[command],cwd};
}
const input=(cwd:string):ExecutionInput=>({taskId:'task',attemptId:'attempt',fence:1,title:'检查',description:'',acceptance:'',feedback:[],cwd});

test('Codex publishes only this turn public messages and safe tool state, including queued events',async t=>{
  const f=await fixture(t),events:unknown[]=[];
  const result=await new CodexExecutor(f).run({...input(f.cwd),onProgress:event=>events.push(event)},new AbortController().signal);
  assert.equal(result.summary,'检查完成');
  assert.equal(events.length,4);
  const rows=events as {id:string;kind:string;text:string;state:string}[];
  assert.deepEqual(rows.map(({kind,text,state})=>({kind,text,state})),[
    {kind:'message',text:'正在检查实现',state:'completed'},
    {kind:'tool',text:'执行命令',state:'running'},
    {kind:'tool',text:'执行命令',state:'failed'},
    {kind:'message',text:'检查完成',state:'completed'},
  ]);
  assert.equal(rows[1].id,rows[2].id);
  assert.ok(!JSON.stringify(events).includes('private'));
  assert.ok(!JSON.stringify(events).includes('foreign'));
});

test('Codex coordination never publishes conversation, and observer errors cannot fail execution',async t=>{
  const f=await fixture(t),events:unknown[]=[];
  await new CodexExecutor(f).run({...input(f.cwd),purpose:'assess',onProgress:event=>events.push(event)},new AbortController().signal);
  assert.deepEqual(events,[]);
  const result=await new CodexExecutor(f).run({...input(f.cwd),onProgress:()=>{throw Error('observer unavailable');}},new AbortController().signal);
  assert.equal(result.summary,'检查完成');
});

test('Codex preserves complete public text until the collector can redact before clipping',async t=>{
  const text='公开说明'.repeat(990)+'-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----';
  const f=await fixture(t,text),messages:string[]=[];
  await new CodexExecutor(f).run({...input(f.cwd),onProgress:event=>{if(event.kind==='message')messages.push(event.text);}},new AbortController().signal);
  assert.equal(messages[0],text);
});
