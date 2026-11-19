import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {DshExecutor} from '../packages/executors/dsh.ts';
import type {ExecutionInput} from '../packages/domain/contracts.ts';

async function fixture(t:TestContext,message='正在检查实现'){
  const cwd=await realpath(await mkdtemp(join(tmpdir(),'mas-dsh-progress-')));
  t.after(()=>rm(cwd,{recursive:true,force:true}));
  const command=join(cwd,'dsh-fixture.mjs');
  await writeFile(command,`#!${process.execPath}
import {createInterface} from 'node:readline';
const emit=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),reply=result=>emit({id:m.id,result});
 if(m.method==='initialize')reply({serverInfo:{name:'deepseek-harness-sdk-runtime',version:'fixture'}});
 if(m.method==='shutdown')process.exit(0);
 if(m.method!=='session/prompt')return;
 const sessionId=m.params.sessionId;
 let seq=0;
 const event=(type,data,session=sessionId)=>emit({method:'session.event',params:{sessionId:session,event:{seq:++seq,type,data}}});
 event('assistant/message',{turn:1,message:{content:[{type:'text',text:'foreign session'}]}},'other');
 event('agent/inbox/spliced',{inserted:[{id:'message'}]});
 event('turn/start',{turn:1});
 event('assistant/chunk',{turn:1,chunk:{type:'reasoning',text:'private reasoning chunk'}});
 event('assistant/message',{turn:1,step:1,message:{content:[{type:'reasoning',text:'private reasoning'},{type:'text',text:${JSON.stringify(message)}},{type:'tool-call',id:'private-call',name:'private-tool',arguments:'private argument'}]}});
 event('tool/call',{turn:2,step:1,callId:'foreign',name:'private-tool',arguments:'private args'});
 event('tool/call',{turn:1,step:1,callId:'private-call',name:'private-tool',arguments:'private args'});
 reply({messageId:'message'});
 event('tool/result',{turn:1,step:1,message:{callId:'unpaired',content:[{type:'text',text:'private output'}],isError:false}});
 event('tool/result',{turn:2,step:1,message:{callId:'private-call',content:[{type:'text',text:'private output'}],isError:false}});
 event('tool/result',{turn:1,step:1,message:{callId:'private-call',content:[{type:'text',text:'private output'}],isError:true},error:{name:'PrivateError',code:'private code'}});
 event('assistant/message',{turn:1,step:2,message:{content:[{type:'text',text:'检查完成'}]}});
 event('turn/end',{turn:1,reason:{kind:'completed'}});
 emit({method:'session.status',params:{sessionId,status:'idle'}});
});
`,{mode:0o700});
  return {command:process.execPath,args:[command],provider:'fixture',model:'fixture',maxTokens:128,cwd};
}
const input=(cwd:string):ExecutionInput=>({taskId:'task',attemptId:'attempt',fence:1,title:'检查',description:'',acceptance:'',feedback:[],cwd});

test('DSH publishes owned public messages and paired safe tool states from queued and live events',async t=>{
  const f=await fixture(t),events:unknown[]=[];
  const result=await new DshExecutor(f).run({...input(f.cwd),onProgress:event=>events.push(event)},new AbortController().signal);
  assert.equal(result.summary,'检查完成');
  const rows=events as {id:string;kind:string;text:string;state:string}[];
  assert.deepEqual(rows.map(({kind,text,state})=>({kind,text,state})),[
    {kind:'message',text:'正在检查实现',state:'completed'},
    {kind:'tool',text:'执行工具',state:'running'},
    {kind:'tool',text:'执行工具',state:'failed'},
    {kind:'message',text:'检查完成',state:'completed'},
  ]);
  assert.equal(rows[1].id,rows[2].id);
  assert.ok(!JSON.stringify(events).includes('private'));
  assert.ok(!JSON.stringify(events).includes('foreign'));
});

test('DSH coordination does not publish conversation and progress observer errors cannot fail execution',async t=>{
  const f=await fixture(t),events:unknown[]=[];
  await new DshExecutor(f).run({...input(f.cwd),purpose:'assess',onProgress:event=>events.push(event)},new AbortController().signal);
  assert.deepEqual(events,[]);
  const result=await new DshExecutor(f).run({...input(f.cwd),onProgress:()=>{throw Error('observer unavailable');}},new AbortController().signal);
  assert.equal(result.summary,'检查完成');
});

test('DSH preserves complete public text until the collector can redact before clipping',async t=>{
  const text='公开说明'.repeat(990)+'-----BEGIN PRIVATE KEY-----\nprivate-body\n-----END PRIVATE KEY-----';
  const f=await fixture(t,text),messages:string[]=[];
  await new DshExecutor(f).run({...input(f.cwd),onProgress:event=>{if(event.kind==='message')messages.push(event.text);}},new AbortController().signal);
  assert.equal(messages[0],text);
});
