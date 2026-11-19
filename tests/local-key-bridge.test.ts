import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import test from 'node:test';
import {openLocalKeyBridge} from '../services/runner/local-key-bridge.ts';

test('native session transcript route stays behind token auth and path validation',async t=>{
  const origin='https://scrum.fruitbuddy.cn',runnerId='11111111-1111-4111-8111-111111111111';
  const bridge=await openLocalKeyBridge({origin,runnerId,add:async(_profile,label)=>({id:'22222222-2222-4222-8222-222222222222',label})});
  t.after(()=>bridge.close());
  const base=`http://127.0.0.1:${bridge.port}`,headers={Origin:origin,'X-MAS-Config-Token':bridge.token};
  const id='33333333-3333-4333-8333-333333333333';
  assert.equal((await fetch(`${base}/native-sessions/transcript/claude/${id}`,{headers:{Origin:origin}})).status,403);
  assert.equal((await fetch(`${base}/native-sessions/transcript/claude/${id}?x=1`,{headers})).status,404);
  assert.equal((await fetch(`${base}/native-sessions/transcript/not-a-provider/${id}`,{headers})).status,404);
  assert.equal((await fetch(`${base}/native-sessions/transcript/claude/not-a-uuid`,{headers})).status,404);
  const degraded=await fetch(`${base}/native-sessions/transcript/dsh/${id}`,{headers});
  assert.equal(degraded.status,200);
  const body=await degraded.json() as {ok:boolean;unavailableReason:string;messages:unknown[]};
  assert.equal(body.ok,true);assert.equal(body.unavailableReason,'dsh');assert.equal(body.messages.length,0);
});

test('browser challenge proves local Runner before a secret is accepted',async()=>{
  const origin='https://scrum.fruitbuddy.cn',runnerId='11111111-1111-4111-8111-111111111111';
  const calls:string[]=[];
  const bridge=await openLocalKeyBridge({origin,runnerId,add:async(_profile,label,key)=>{calls.push(key);return {id:'22222222-2222-4222-8222-222222222222',label};}});
  try{
    const base=`http://127.0.0.1:${bridge.port}`,nonce='a'.repeat(32),headers={Origin:origin};
    const challenge=await fetch(`${base}/challenge?nonce=${nonce}`,{headers});
    assert.equal(challenge.status,200);
    assert.deepEqual(await challenge.json(),{runnerId,proof:createHmac('sha256',Buffer.from(bridge.token,'hex')).update(nonce).digest('hex')});
    assert.equal((await fetch(`${base}/challenge?nonce=${nonce}`,{headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await fetch(`${base}/native-sessions`,{headers})).status,403);
    assert.equal((await fetch(`${base}/native-sessions`,{headers:{...headers,'X-MAS-Config-Token':'0'.repeat(64)}})).status,403);
    assert.equal((await fetch(`${base}/native-sessions/send`,{method:'POST',headers:{...headers,'X-MAS-Config-Token':bridge.token,'Content-Type':'application/json'},body:JSON.stringify({provider:'codex',id:'11111111-1111-4111-8111-111111111111',requestId:'22222222-2222-4222-8222-222222222222',prompt:''})})).status,409);
    const payload=JSON.stringify({profile:'codex-code',label:'另一个 Codex Key',apiKey:'sk-secret-test'});
    assert.equal((await fetch(`${base}/api-key`,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-MAS-Config-Token':'0'.repeat(64)},body:payload})).status,403);
    assert.deepEqual(calls,[]);
    const response=await fetch(`${base}/api-key`,{method:'POST',headers:{...headers,'Content-Type':'application/json','X-MAS-Config-Token':bridge.token},body:payload});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{ok:true,credential:{id:'22222222-2222-4222-8222-222222222222',label:'另一个 Codex Key'}});
    assert.deepEqual(calls,['sk-secret-test']);
  }finally{await bridge.close();}
});
