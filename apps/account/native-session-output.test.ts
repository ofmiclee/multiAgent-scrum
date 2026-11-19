import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSessionOutput} from './native-session-output';

test('formats CodeBuddy events without exposing initialization metadata',()=>{
  const output=[
    {type:'system',subtype:'init',session_id:'internal',tools:['Read'],apiKeySource:'internal'},
    {type:'assistant',message:{content:[{type:'thinking',thinking:'先检查\n目录结构'},{type:'tool_use',name:'Read',input:{file_path:'/tmp/README.md'}},{type:'text',text:'已找到入口。'}]}},
    {type:'result',result:'已找到入口。'},
  ].map(row=>JSON.stringify(row)).join('\n');
  assert.deepEqual(parseSessionOutput(output),[
    {kind:'thinking',text:'先检查\n目录结构'},
    {kind:'tool',text:'Read',detail:'/tmp/README.md'},
    {kind:'text',text:'已找到入口。'},
  ]);
});

test('joins streamed deltas and replaces their full snapshot without duplicating text',()=>{
  const events=[
    {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'先检查'}}},
    {type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'目录'}}},
    {type:'assistant',message:{content:[{type:'thinking',thinking:'先检查目录'}]}},
    {type:'stream_event',event:{type:'content_block_delta',index:1,delta:{type:'text_delta',text:'答复'}}},
    {type:'assistant',message:{content:[{type:'text',text:'答复'}]}},
  ];
  assert.deepEqual(parseSessionOutput(events.map(row=>JSON.stringify(row)).join('\n')),[{kind:'thinking',text:'先检查目录'},{kind:'text',text:'答复'}]);
});

test('accepts batch output and Codex events while hiding incomplete JSON fragments',()=>{
  assert.deepEqual(parseSessionOutput(JSON.stringify([{type:'message',role:'assistant',content:[{type:'output_text',text:'正文'}]}],null,2)),[{kind:'text',text:'正文'}]);
  assert.deepEqual(parseSessionOutput('cut-off metadata"}\n'+JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'思考'}})+'\n{"type":"assistant"'),[{kind:'thinking',text:'思考'}]);
  assert.deepEqual(parseSessionOutput('{"type":"system","tools":['),[]);
  assert.deepEqual(parseSessionOutput('tools list fragment',true),[]);
  assert.deepEqual(parseSessionOutput(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'完整行'}]}})+'\n',true),[{kind:'text',text:'完整行'}]);
  assert.deepEqual(parseSessionOutput('[INFO] 正在读取文件'),[{kind:'text',text:'[INFO] 正在读取文件'}]);
  assert.deepEqual(parseSessionOutput('正在分析仓库结构…'),[{kind:'text',text:'正在分析仓库结构…'}]);
  assert.deepEqual(parseSessionOutput('null\n42\n'+JSON.stringify({type:'assistant',message:{content:[null,{type:'text',text:'安全正文'}]}})),[{kind:'text',text:'安全正文'}]);
});
