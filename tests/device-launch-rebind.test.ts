import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {handleDeviceLaunch,handleDeviceLaunchAttach} from '../services/account/device-launch.ts';
import {handleRunnerConnection,hashRunnerSecret} from '../services/account/runner-connections.ts';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('an explicit launch reconnects the same owner’s revoked Runner without changing its identity or Agent bindings',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  const pool={connect:async()=>({query:async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.affectedRows??result.rows.length};},release(){}})} as unknown as Pool;
  for(const [identity,user] of [['owner',id(1)],['other',id(2)]]){
    await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',[identity,identity,`${identity}@example.test`]);
    await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[user,identity,identity]);
  }
  const runnerId=id(3),credential='a'.repeat(64);
  await db.query(`INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash,revoked_at)
    VALUES($1,$2,'Mac Runner',$3,now())`,[runnerId,id(1),hashRunnerSecret(credential)]);
  await db.query(`INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,ready_until,ready_session_hash)
    VALUES($1,$2,$3,'codex-code',now()-interval '1 hour',$4)`,[id(4),runnerId,id(1),'0'.repeat(64)]);
  const launch=async(identityId:string)=>{
    const response=await handleDeviceLaunch(pool,{id:identityId,name:identityId},new Request('https://scrum.fruitbuddy.cn/api/account/device-launch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identityId})}));
    if(!('ticket' in response))throw Error('Launch did not return a ticket');
    return response;
  };
  const attach=(ticket:string,token=credential)=>handleDeviceLaunchAttach(pool,new Request('https://scrum.fruitbuddy.cn/api/runner/launch/attach',{
    method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({ticket,runnerId,name:'Mac Runner'})}));
  const status=()=>handleRunnerConnection(pool,new Request('https://scrum.fruitbuddy.cn/api/runner/status',{
    method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify({runnerId})}));

  await assert.rejects(status(),error=>error===403);
  const foreign=await launch('other');
  await assert.rejects(attach(foreign.ticket),error=>error===403);
  const own=await launch('owner');
  await assert.rejects(attach(own.ticket,'b'.repeat(64)),error=>error===403);
  assert.equal((await db.query<{revoked_at:Date|null}>('SELECT revoked_at FROM mas_business_runner_device WHERE id=$1',[runnerId])).rows[0].revoked_at!==null,true);

  await attach(own.ticket);
  const state=await handleDeviceLaunch(pool,{id:'owner',name:'owner'},new Request(`https://scrum.fruitbuddy.cn/api/account/device-launch/${own.id}`));
  assert.ok('status' in state);
  assert.equal(state.status,'connected');
  assert.equal(state.device?.runnerId,runnerId);
  const rows=(await db.query<{revoked_at:Date|null;owner_id:string}>('SELECT revoked_at,owner_id FROM mas_business_runner_device WHERE id=$1',[runnerId])).rows;
  assert.equal(rows[0].revoked_at,null);
  assert.equal(rows[0].owner_id,id(1));
  assert.equal((await db.query<{runner_id:string}>('SELECT runner_id FROM mas_business_agent WHERE id=$1',[id(4)])).rows[0].runner_id,runnerId);
  const connected=await status();assert.ok('agentCount' in connected);assert.equal(connected.agentCount,1);
});
