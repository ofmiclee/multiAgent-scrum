import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

test('credential migration backfills both legacy profiles on one Runner',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  const migrations=localIdentityMigrations.filter(file=>!file.startsWith('035-'));
  for(const file of migrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',['identity-migration','Owner','migration@example.test']);
  await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(1),'identity-migration','Owner']);
  await db.query('INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash) VALUES($1,$2,$3,$4)',[id(2),id(1),'Dual profile Runner','0'.repeat(64)]);
  for(const [number,profile] of [[3,'dsh-text'],[4,'codex-code']] as const)
    await db.query(`INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,enabled,ready_until,ready_session_hash,name)
      VALUES($1,$2,$3,$4,true,to_timestamp(0),$5,$6)`,[id(number),id(2),id(1),profile,'0'.repeat(64),profile]);
  await db.exec(await readFile(new URL('../services/identity/migrations/035-agent-credentials.sql',import.meta.url),'utf8'));
  const rows=(await db.query<{profile:string;id:string}>('SELECT profile,id FROM mas_business_runner_credential WHERE runner_id=$1 ORDER BY profile',[id(2)])).rows;
  assert.deepEqual(rows,[{profile:'codex-code',id:'legacy'},{profile:'dsh-text',id:'legacy'}]);
});
