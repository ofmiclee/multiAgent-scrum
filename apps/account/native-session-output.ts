export type SessionOutputBlock={kind:'thinking'|'text'|'tool'|'status';text:string;detail?:string};
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const string=(value:unknown)=>typeof value==='string'?value:'';

/** Present CLI events, never protocol metadata. Keep the original log separately for diagnostics. */
export function parseSessionOutput(output:string,truncated=false):SessionOutputBlock[]{
  const blocks:SessionOutputBlock[]=[];
  const streamed=new Map<number,number>();
  const items=new Map<string,number>();
  let structured=false,final='';
  function content(value:unknown):SessionOutputBlock|null{
    const part=object(value);
    if(part.type==='thinking')return {kind:'thinking',text:string(part.thinking)};
    if(part.type==='text'||part.type==='output_text')return {kind:'text',text:string(part.text)};
    if(part.type==='tool_use'){
      const input=object(part.input);
      return {kind:'tool',text:string(part.name)||'工具调用',detail:string(input.description)||string(input.file_path)||string(input.command)};
    }
    return null;
  }
  function consume(value:unknown){
    const row=object(value);
    if(typeof row.type!=='string')return;
    structured=true;
    const event=object(row.type==='stream_event'?row.event:row);
    if(event.type==='message_start')streamed.clear();
    if(event.type==='content_block_start'||event.type==='content_block_delta'){
      const index=typeof event.index==='number'?event.index:0;
      const delta=object(event.delta);
      const block=event.type==='content_block_start'?content(event.content_block):
        delta.type==='thinking_delta'?{kind:'thinking' as const,text:string(delta.thinking)}:
        delta.type==='text_delta'?{kind:'text' as const,text:string(delta.text)}:null;
      if(block){const previous=streamed.get(index);if(previous!==undefined)blocks[previous].text+=block.text;else{streamed.set(index,blocks.length);blocks.push(block);}}
    }
    const parts=row.type==='assistant'?object(row.message).content:row.type==='message'&&row.role==='assistant'?row.content:null;
    if(Array.isArray(parts)){
      parts.forEach(part=>{const block=content(part);if(!block)return;const previous=[...streamed.values()].find(position=>blocks[position].kind===block.kind&&(blocks[position].text===block.text||block.text.startsWith(blocks[position].text)));if(previous!==undefined){blocks[previous]=block;for(const [key,position] of streamed)if(position===previous)streamed.delete(key);}else blocks.push(block);});
      streamed.clear();
    }
    if(row.type==='item.started'||row.type==='item.updated'||row.type==='item.completed'){
      const item=object(row.item);
      const block:SessionOutputBlock|null=item.type==='reasoning'?{kind:'thinking',text:string(item.text)}:
        item.type==='agent_message'?{kind:'text',text:string(item.text)}:
        item.type==='command_execution'?{kind:'tool',text:'执行命令',detail:string(item.command)}:
        item.type==='mcp_tool_call'?{kind:'tool',text:string(item.tool)||'工具调用',detail:string(item.server)}:null;
      if(block){const id=string(item.id),previous=id?items.get(id):undefined;if(previous!==undefined)blocks[previous]=block;else{if(id)items.set(id,blocks.length);blocks.push(block);}}
    }
    if(row.type==='result')final=string(row.result);
    if(row.type==='error'){const text=string(row.message)||string(object(row.error).message);if(text)blocks.push({kind:'status',text});}
  }
  try{
    const value:unknown=JSON.parse(output);
    if(Array.isArray(value))value.forEach(consume);else consume(value);
    structured=true;
  }catch{
    for(const line of output.split('\n')){try{consume(JSON.parse(line));}catch{/* Partial lines remain available only in the raw log. */}}
  }
  if(final&&!blocks.some(block=>block.kind==='text'))blocks.push({kind:'text',text:final});
  if(!structured&&!truncated&&output.trim()&&!/^\s*(?:\{\s*(?:"|$)|\[\s*(?:[\[{]|$))/.test(output))blocks.push({kind:'text',text:output});
  return blocks.filter(block=>block.text.trim());
}
