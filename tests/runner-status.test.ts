import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {handleRunnerConnection,hashRunnerSecret} from '../services/account/runner-connections.ts';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('Runner can read its own connection and Agent binding status without changing the session',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  const pool={connect:async()=>({query:async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.affectedRows??result.rows.length};},release(){}})} as unknown as Pool;
  await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',['identity-1','Owner','owner@example.test']);
  await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(1),'identity-1','Owner']);
  const credential='a'.repeat(64),session='b'.repeat(64);
  await db.query(`INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash,session_hash,session_until,last_seen)
    VALUES($1,$2,'Device',$3,$4,now()+interval '1 hour',now())`,[id(2),id(1),hashRunnerSecret(credential),hashRunnerSecret(session)]);
  await db.query(`INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,ready_until,ready_session_hash)
    VALUES($1,$2,$3,'dsh-text',now()-interval '1 hour',$4)`,[id(3),id(2),id(1),'0'.repeat(64)]);
  const status=(token=credential)=>handleRunnerConnection(pool,new Request('http://localhost/api/runner/status',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({runnerId:id(2)})}));
  const before=(await db.query('SELECT session_hash,session_until,last_seen FROM mas_business_runner_device WHERE id=$1',[id(2)])).rows;
  assert.deepEqual(await status(),{connected:true,agentCount:1,readyAgentCount:0});
  assert.deepEqual((await db.query('SELECT session_hash,session_until,last_seen FROM mas_business_runner_device WHERE id=$1',[id(2)])).rows,before);
  await assert.rejects(status('c'.repeat(64)),error=>error===403);
  await db.query("UPDATE mas_business_runner_device SET session_until=now()-interval '1 second' WHERE id=$1",[id(2)]);
  assert.deepEqual(await status(),{connected:false,agentCount:1,readyAgentCount:0});
});
