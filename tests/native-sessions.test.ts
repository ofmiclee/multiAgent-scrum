import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {zstdCompressSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {listDshSessionMetadata,listTranscriptMetadata,sessionSendSchema,findTranscriptFile,readTranscriptMessages} from '../services/runner/native-sessions.ts';

test('local transcript discovery returns only bounded metadata and ignores symlinks',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-session-discovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'project');await mkdir(project);
  const id='11111111-1111-4111-8111-111111111111';
  await writeFile(join(project,id+'.jsonl'),JSON.stringify({type:'message',cwd:'/tmp/example-project',sessionId:id,content:'private prompt must not be returned'})+'\n'+JSON.stringify({type:'ai-title',cwd:'/tmp/example-project',aiTitle:'Review work'})+'\n');
  await symlink(join(project,id+'.jsonl'),join(project,'22222222-2222-4222-8222-222222222222.jsonl'));
  const sessions=await listTranscriptMetadata(root,'codebuddy');
  assert.equal(sessions.length,1);assert.equal(sessions[0].id,id);assert.equal(sessions[0].cwd,'/tmp/example-project');
  assert.equal(sessions[0].title,'Review work');assert.equal(JSON.stringify(sessions).includes('private prompt'),false);
  assert.equal(sessionSendSchema.safeParse({provider:'codex',id,requestId:id,prompt:''}).success,false);
});

test('DSH discovery reads session headers without exposing transcript content',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-dsh-session-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'project','session-11111111-1111-4111-8111-111111111111');await mkdir(directory,{recursive:true});
  const plain=JSON.stringify({type:'session',id:'session-11111111-1111-4111-8111-111111111111',cwd:'/tmp/dsh-project',createdAt:1})+'\n'+JSON.stringify({type:'message',data:{text:'private transcript text'}})+'\n';
  await writeFile(join(directory,'session.jsonl.zstd'),zstdCompressSync(Buffer.from(plain)));
  const sessions=await listDshSessionMetadata(root);
  assert.equal(sessions.length,1);assert.equal(sessions[0].provider,'dsh');assert.equal(sessions[0].cwd,'/tmp/dsh-project');
  assert.equal(sessions[0].canResume,false);assert.equal(JSON.stringify(sessions).includes('private transcript text'),false);
});

test('concurrent sends reserve one native turn before asynchronous discovery',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-session-send-'));
  const command=join(root,'fake-codex');
  await writeFile(command,'#!'+process.execPath+'\nprocess.stdin.resume();setInterval(()=>{},1000);\n',{mode:0o700});
  const {NativeSessionService}=await import('../services/runner/native-sessions.ts');
  const service=new NativeSessionService({home:root,codexCommand:command});
  t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve);
  const id='11111111-1111-4111-8111-111111111111';
  const metadata={provider:'codex' as const,id,cwd:root,title:'Fixture',updatedAt:0,state:'idle' as const,canResume:true};
  service.list=async()=>{await gate;return {accounts:{codex:{installed:true,status:'ready'},claude:{installed:false,status:'unknown'},codebuddy:{installed:false,status:'unknown'},dsh:{installed:false,status:'unknown'}},projects:[root],sessions:[metadata]};};
  const request={provider:'codex',id,requestId:id,prompt:'Fixture only'};
  const first=service.send(request),second=service.send(request);
  release();
  const outcomes=await Promise.allSettled([first,second]);
  assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(row=>row.status==='rejected').length,1);
  const accepted=outcomes.find(row=>row.status==='fulfilled')!;
  assert.equal(accepted.status,'fulfilled');
  const replay=await service.send(request);
  assert.equal(replay.operationId,accepted.value.operationId);
});

test('old transcript metadata does not establish that a Claude session is idle',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-session-old-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'project');await mkdir(project);
  const id='11111111-1111-4111-8111-111111111111',file=join(project,id+'.jsonl');
  await writeFile(file,JSON.stringify({cwd:'/tmp/example-project'})+'\n');
  const {utimes}=await import('node:fs/promises');await utimes(file,1,1);
  const [session]=await listTranscriptMetadata(root,'claude');
  assert.equal(session.state,'unknown');
  assert.equal(session.canResume,false);
});

test('transcript reading returns bounded claude messages without tool or sidechain noise',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-claude-transcript-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'project');await mkdir(project);
  const id='11111111-1111-4111-8111-111111111111';
  const rows=[
    {type:'file-history-snapshot',cwd:'/tmp/example-project'},
    {type:'user',message:{content:'帮我检查这个文件'},timestamp:'2026-10-16T02:00:00.000Z'},
    {type:'assistant',message:{content:[{type:'text',text:'我看过文件了。'}]},timestamp:'2026-10-16T02:00:05.000Z'},
    {type:'user',isSidechain:true,message:{content:'内部子链消息不应出现'},timestamp:'2026-10-16T02:00:06.000Z'},
    {type:'assistant',message:{content:[{type:'tool_use',text:'tool payload 不应出现'}]},timestamp:'2026-10-16T02:00:07.000Z'},
    JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'超长行记录不进入结果'}]}}).padEnd(64_100,'x'),
  ];
  await writeFile(join(project,id+'.jsonl'),rows.map(row=>typeof row==='string'?row:JSON.stringify(row)).join('\n')+'\n');
  const path=await findTranscriptFile(root,id);
  assert.equal(path,join(project,id+'.jsonl'));
  assert.equal(await findTranscriptFile(root,'not-a-uuid'),null);
  const {messages}=await readTranscriptMessages(path!,'claude');
  assert.equal(messages.length,2);
  assert.equal(messages[0].role,'user');assert.equal(messages[0].text,'帮我检查这个文件');assert.equal(messages[0].timestamp,Date.parse('2026-10-16T02:00:00.000Z'));
  assert.equal(messages[1].role,'assistant');assert.equal(messages[1].text,'我看过文件了。');
  const serialized=JSON.stringify(messages);
  assert.equal(serialized.includes('内部子链'),false);assert.equal(serialized.includes('tool payload'),false);assert.equal(serialized.includes('超长行记录'),false);
});

test('transcript reading returns bounded codebuddy messages and truncates long text',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-codebuddy-transcript-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const project=join(root,'project');await mkdir(project);
  const id='11111111-1111-4111-8111-111111111111';
  const long='长'.repeat(9000);
  const rows=[
    {type:'reasoning',cwd:'/tmp/example-project',content:'推理记录不应出现'},
    {type:'message',role:'user',content:[{type:'input_text',text:'第一轮提问'}],timestamp:1760000000000},
    {type:'function_call',name:'shell',content:'函数调用不应出现'},
    {type:'message',role:'assistant',content:[{type:'output_text',text:long}],timestamp:1760000001000},
  ];
  await writeFile(join(project,id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const path=await findTranscriptFile(root,id);
  const {messages,truncated}=await readTranscriptMessages(path!,'codebuddy');
  assert.equal(messages.length,2);
  assert.equal(messages[0].text,'第一轮提问');
  assert.equal(messages[1].text.length,8001);assert.ok(messages[1].text.endsWith('…'));
  assert.equal(truncated,true);
  assert.equal(JSON.stringify(messages).includes('推理记录'),false);
  assert.equal(JSON.stringify(messages).includes('函数调用'),false);
});

test('transcript service pages backwards by cursor and degrades codex and dsh',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-transcript-service-'));
  const {NativeSessionService}=await import('../services/runner/native-sessions.ts');
  const service=new NativeSessionService({home:root});
  t.after(()=>rm(root,{recursive:true,force:true}));
  const codebuddyProject=join(root,'.codebuddy','projects','project');await mkdir(codebuddyProject,{recursive:true});
  const id='11111111-1111-4111-8111-111111111111';
  const rows=[];
  for(let index=0;index<60;index++)rows.push({type:'message',role:index%2?'assistant':'user',content:[{type:index%2?'output_text':'input_text',text:'消息 '+index}],timestamp:1760000000000+index});
  await writeFile(join(codebuddyProject,id+'.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const degradedCodex=await service.transcript('codex',id);
  assert.equal(degradedCodex.messages.length,0);assert.equal(degradedCodex.unavailableReason,'codex');
  const degradedDsh=await service.transcript('dsh',id);
  assert.equal(degradedDsh.messages.length,0);assert.equal(degradedDsh.unavailableReason,'dsh');
  const firstPage=await service.transcript('codebuddy',id);
  assert.equal(firstPage.messages.length,50);assert.equal(firstPage.messages[0].text,'消息 10');assert.equal(firstPage.messages[49].text,'消息 59');
  assert.equal(firstPage.hasMore,true);assert.equal(firstPage.nextCursor,'50');
  const secondPage=await service.transcript('codebuddy',id,firstPage.nextCursor!);
  assert.equal(secondPage.messages.length,10);assert.equal(secondPage.messages[0].text,'消息 0');
  assert.equal(secondPage.hasMore,false);assert.equal(secondPage.nextCursor,null);
});

test('operation status exposes a bounded tail of live process output',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mas-session-output-'));
  const command=join(root,'fake-codex');
  // The fake CLI streams incremental JSONL lines then reports the final agent message.
  await writeFile(command,'#!'+process.execPath+'\nprocess.stdin.resume();const lines=[];for(let i=0;i<300;i++)lines.push(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"chunk "+i}}));let i=0;const timer=setInterval(()=>{if(i>=lines.length){clearInterval(timer);process.stdout.write(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"final answer"}})+"\\n");process.exit(0);return;}process.stdout.write(lines[i]+"\\n");i++;},5);\n',{mode:0o700});
  const {NativeSessionService}=await import('../services/runner/native-sessions.ts');
  const service=new NativeSessionService({home:root,codexCommand:command});
  t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
  const id='11111111-1111-4111-8111-111111111111';
  service.list=async()=>({accounts:{codex:{installed:true,status:'ready'},claude:{installed:false,status:'unknown'},codebuddy:{installed:false,status:'unknown'},dsh:{installed:false,status:'unknown'}},projects:[root],sessions:[{provider:'codex',id,cwd:root,title:'Fixture',updatedAt:0,state:'idle',canResume:true}]});
  const {operationId}=await service.send({provider:'codex',id,requestId:'22222222-2222-4222-8222-222222222222',prompt:'Fixture only'});
  const running=service.status(operationId);
  assert.equal(running.output.length<=16_384,true);
  await (service as unknown as {operations:Map<string,{closed?:Promise<void>}>}).operations.get(operationId)!.closed;
  const finished=service.status(operationId);
  assert.equal(finished.state,'done');
  assert.equal(finished.result,'final answer');
  assert.equal(typeof finished.output,'string');assert.equal(finished.output.length<=16_384,true);
});

async function runFakeCodeBuddy(t:{after:(fn:()=>Promise<void>)=>void},lines:string[],providerOutput=''){
  const root=await mkdtemp(join(tmpdir(),'mas-session-codebuddy-'));
  const command=join(root,'fake-codebuddy');
  const script='#!'+process.execPath+'\nprocess.stdin.resume();const lines='+JSON.stringify(lines)+';let i=0;const timer=setInterval(()=>{if(i>=lines.length){clearInterval(timer);'+(providerOutput?'process.stdout.write('+JSON.stringify(providerOutput)+');':'')+'process.exit(0);return;}process.stdout.write(lines[i]+"\\n");i++;},5);\n';
  await writeFile(command,script,{mode:0o700});
  const {NativeSessionService}=await import('../services/runner/native-sessions.ts');
  const service=new NativeSessionService({home:root,codebuddyCommand:command});
  t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});
  const id='11111111-1111-4111-8111-111111111111';
  service.list=async()=>({accounts:{codex:{installed:false,status:'unknown'},claude:{installed:false,status:'unknown'},codebuddy:{installed:true,status:'ready'},dsh:{installed:false,status:'unknown'}},projects:[root],sessions:[{provider:'codebuddy',id,cwd:root,title:'Fixture',updatedAt:0,state:'idle',canResume:true}]});
  const {operationId}=await service.send({provider:'codebuddy',id,requestId:'22222222-2222-4222-8222-222222222222',prompt:'Fixture only'});
  await (service as unknown as {operations:Map<string,{closed?:Promise<void>}>}).operations.get(operationId)!.closed;
  return service.status(operationId);
}

test('stream-json reasoning is extracted live and the final reply comes from the result event',async t=>{
  const finished=await runFakeCodeBuddy(t,[
    JSON.stringify({type:'system',subtype:'init',session_id:'s',tools:[]}),
    JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking:'先看目录结构'}]}}),
    JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'thinking',thinking:'，再读 README'}]}}),
    JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'这是答复正文'}]}}),
    JSON.stringify({type:'result',subtype:'success',is_error:false,result:'这是答复正文'}),
  ]);
  assert.equal(finished.state,'done');
  assert.equal(finished.result,'这是答复正文');
  assert.equal(finished.thinking,'先看目录结构，再读 README');
  assert.equal(finished.thinkingTruncated,false);
});

test('a pretty-printed batch json event array still yields a clean reply instead of raw JSON',async t=>{
  const batch=JSON.stringify([
    {type:'message',role:'user',source:'initial-user-message',content:[{type:'input_text',text:'续接一下'}]},
    {type:'message',role:'assistant',content:[{type:'output_text',text:'结构化后的回复'}]},
    {type:'result',subtype:'success',is_error:false,result:'结构化后的回复',_meta:{baggage:'codebuddy.session_id=x'}},
  ],null,2);
  const finished=await runFakeCodeBuddy(t,[],batch+'\n');
  assert.equal(finished.state,'done');
  assert.equal(finished.result,'结构化后的回复');
  assert.equal(finished.result.includes('traceparent'),false);
  assert.equal(finished.result.includes('baggage'),false);
});
