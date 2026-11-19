import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {handleCoordinatorRequest} from '../services/account/coordinator.ts';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import {announceAgent,handleAgentRequest,listAgents} from '../services/account/agents.ts';
import {hashRunnerSecret} from '../services/account/runner-connections.ts';
import {createAccountService} from '../services/account/service.ts';
import type {IdentityService} from '../services/identity/service.ts';
import {mutateBoard} from '../services/account/boards.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const principal=(n:number)=>({id:'identity-'+n,name:'Member '+n});

test('coordinator ownership, atomic authorization, replay and conflict checks use PostgreSQL',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  // The adapter runs real SQL in isolated PostgreSQL WASM, not simulated query results.
  // It is single-connection; multi-connection lock scheduling is not covered here.
  const pool={connect:async()=>({query:async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.affectedRows??r.rows.length};},release(){}})} as unknown as Pool;
  for(const n of [1,2,3]){
    await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',[principal(n).id,principal(n).name,n+'@example.test']);
    await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(n),principal(n).id,principal(n).name]);
  }
  await db.query('INSERT INTO mas_business_organization(id,name,created_by) VALUES($1,$2,$3)',[id(10),'Test team',id(1)]);
  for(const n of [1,2,3])await db.query('INSERT INTO mas_business_membership(organization_id,user_id,role) VALUES($1,$2,$3)',[id(10),id(n),n===1?'owner':'member']);
  await db.exec('BEGIN');
  await db.query('INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id) VALUES($1,$2,$3,$4,$5)',[id(20),id(10),'Test project',id(1),id(21)]);
  await db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(21),id(20),'Board']);
  await db.exec('COMMIT');
  for(const n of [1,2])await db.query('INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role) VALUES($1,$2,$3,$4)',[id(20),id(10),id(n),n===1?'owner':'member']);
  for(const n of [1,2])await db.query('INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash) VALUES($1,$2,$3,$4)',[id(30+n),id(n),'Device '+n,'0'.repeat(64)]);
  for(const n of [41,42,43,44,45,46]){
    await db.query(`INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,enabled,ready_until,ready_session_hash,name)
      VALUES($1,$2,$3,$4,$5,to_timestamp(0),$6,$7)`,[id(n),id(n===44?32:31),id(n===44?2:1),n===46?'demo':'dsh-text',n!==45,'0'.repeat(64),'Agent '+n]);
  }
  const get=(actor=1)=>handleCoordinatorRequest(pool,principal(actor),new Request('http://localhost/api/account/projects/'+id(20)+'/coordinator/agents'));
  await t.test('model directory returns vendor metadata for the selector',async()=>{
    const result=await handleAgentRequest(pool,principal(1),new Request('http://localhost/api/account/agent-models')) as {identityId:string;models:{vendor:string;profile:string;model:string;displayName:string;relativeCost:number;isDefault:boolean}[]};
    assert.equal(result.identityId,principal(1).id);
    assert.ok(result.models.some(model=>model.vendor==='deepseek'&&model.profile==='dsh-text'&&model.model==='deepseek-v4-pro'&&model.displayName==='DeepSeek V4 Pro'));
    assert.ok(result.models.some(model=>model.vendor==='openai'&&model.profile==='codex-code'&&model.model==='gpt-6-astra'&&model.displayName==='6 Astra'));
    assert.ok(result.models.some(model=>model.vendor==='openai'&&model.profile==='codex-code'&&model.model==='gpt-6-sol'&&model.displayName==='6 Sol'&&model.relativeCost===2));
    assert.ok(result.models.some(model=>model.vendor==='openai'&&model.profile==='codex-code'&&model.model==='gpt-6-luna'&&model.displayName==='6 Luna'&&model.relativeCost===1));
    assert.ok(result.models.some(model=>model.vendor==='openai'&&model.profile==='codex-code'&&model.model==='gpt-5.5'&&model.displayName==='5.5'));
    assert.equal(result.models.find(model=>model.model==='gpt-5.6-terra')?.isDefault,true);
    assert.equal(result.models.find(model=>model.model==='gpt-6-astra')?.relativeCost,3);
    assert.ok(result.models.filter(model=>model.vendor==='openai'&&model.model!=='gpt-6-astra').every(model=>model.relativeCost<3));
  });
  await t.test('model changes use catalog routing defaults',async()=>{
    const response=await handleAgentRequest(pool,principal(1),new Request('http://localhost/api/account/agents/'+id(41),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identityId:principal(1).id,expectedVersion:1,model:'deepseek-v4-flash',enabled:true})}));
    assert.deepEqual(response,{identityId:principal(1).id,version:2});
    assert.deepEqual((await db.query('SELECT difficulty_min,difficulty_max,relative_cost FROM mas_business_agent WHERE id=$1',[id(41)])).rows,[{difficulty_min:1,difficulty_max:3,relative_cost:1}]);
  });
  await t.test('detail save commits model, account and routing together and rejects stale or foreign input',async t=>{
    await db.query(`INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,name,ready_until,ready_session_hash)
      VALUES($1,$2,$3,'dsh-text','Detail test',now()+interval '1 hour',$4)`,[id(48),id(31),id(1),'0'.repeat(64)]);
    t.after(()=>db.query('DELETE FROM mas_business_agent WHERE id=$1',[id(48)]));
    for(const [runner,owner,key] of [[31,1,81],[32,2,82]])await db.query(`INSERT INTO mas_business_runner_credential(runner_id,owner_id,id,profile,kind,label) VALUES($1,$2,$3,'dsh-text','api-key','Test key')`,[id(runner),id(owner),id(key)]);
    const item={id:id(48),expectedVersion:1,enabled:false,model:'deepseek-v4-pro',credentialId:id(81),routing:{expectedVersion:1,difficultyMin:2,difficultyMax:4,preference:'quality',relativeCost:3}};
    const save=(value:typeof item)=>handleAgentRequest(pool,principal(1),new Request('http://localhost/api/account/agent-settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identityId:principal(1).id,agents:[value]})}));
    const snapshot=async()=>(await db.query<Record<string,unknown>>('SELECT model,enabled,credential_id,difficulty_min,difficulty_max,routing_preference,relative_cost,version,routing_version,ready_until FROM mas_business_agent WHERE id=$1',[id(48)])).rows[0];
    const before=await snapshot();
    await assert.rejects(save({...item,credentialId:id(82)}),error=>error===409);
    assert.deepEqual(await snapshot(),before);
    await assert.rejects(save({...item,routing:{...item.routing,expectedVersion:2}}),error=>error===409);
    assert.deepEqual(await snapshot(),before);
    await save(item);
    const saved=await snapshot();
    assert.deepEqual({...saved,ready_until:undefined},{model:'deepseek-v4-pro',enabled:false,credential_id:id(81),difficulty_min:2,difficulty_max:4,routing_preference:'quality',relative_cost:3,version:2,routing_version:2,ready_until:undefined});
    assert.equal(new Date(saved.ready_until as string).getTime(),0);
    await save(item); // A lost response can be retried without double-applying.
    assert.deepEqual(await snapshot(),saved);
    await assert.rejects(save({...item,model:'deepseek-v4-flash'}),error=>error===409);
    assert.deepEqual(await snapshot(),saved);
    // A concurrent routing save may already have applied the same values while the model is still old.
    await db.query('UPDATE mas_business_agent SET model=$2,version=3 WHERE id=$1',[id(48),'deepseek-v4-flash']);
    await save({...item,expectedVersion:3});
    assert.deepEqual(await snapshot(),{...saved,version:4});
  });
  const set=(agent:number,version:number,actor=1,authorize=true)=>handleCoordinatorRequest(pool,principal(actor),new Request('http://localhost/api/account/projects/'+id(20)+'/coordinator',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identityId:principal(actor).id,agentId:id(agent),expectedVersion:version,...(authorize?{authorize:true}:{})})}));
  const status=()=>db.query<{agent_id:string;version:number}>('SELECT agent_id,version FROM mas_business_project_coordinator');
  const grant=(agent:number)=>db.query<{enabled:boolean;version:number}>('SELECT enabled,version FROM mas_business_agent_project WHERE agent_id=$1',[id(agent)]);
  const rejects=(operation:Promise<unknown>,code:number)=>assert.rejects(operation,error=>error===code);

  await t.test('Runner availability never creates a Default Agent',async()=>{
    const credential='a'.repeat(64),sessionId='b'.repeat(64);
    await db.query(`UPDATE mas_business_runner_device SET credential_hash=$2,session_hash=$3,session_until=now()+interval '1 hour'
      WHERE id=$1`,[id(31),hashRunnerSecret(credential),hashRunnerSecret(sessionId)]);
    const before=(await db.query('SELECT id FROM mas_business_agent WHERE runner_id=$1',[id(31)])).rows.length;
    const result=await announceAgent(pool,new Request('http://localhost/api/runner/tasks/poll',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(31),sessionId,profile:'dsh-text',readyProfiles:['dsh-text'],announceOnly:true})}),['dsh-text']);
    assert.equal(result,null);
    assert.equal((await db.query('SELECT id FROM mas_business_agent WHERE runner_id=$1',[id(31)])).rows.length,before);
    assert.equal((await db.query<{count:number}>(`SELECT count(*)::int AS count FROM mas_business_agent
      WHERE runner_id=$1 AND profile='dsh-text' AND ready_until>clock_timestamp()`,[id(31)])).rows[0].count,4);
    const keyId=id(90),announce=(credentials:{id:string;profile:'dsh-text';kind:'api-key';label:string}[])=>announceAgent(pool,new Request('http://localhost/api/runner/tasks/poll',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(31),sessionId,profile:'dsh-text',readyProfiles:['dsh-text'],credentials,announceOnly:true})}),['dsh-text']);
    await announce([{id:keyId,profile:'dsh-text',kind:'api-key',label:'第二个 Key'}]);
    const version=(await db.query<{version:number}>('SELECT version FROM mas_business_agent WHERE id=$1',[id(42)])).rows[0].version;
    await handleAgentRequest(pool,principal(1),new Request('http://localhost/api/account/agents/'+id(42),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identityId:principal(1).id,expectedVersion:version,credentialId:keyId})}));
    await announce([{id:keyId,profile:'dsh-text',kind:'api-key',label:'第二个 Key'}]);
    const readiness=(await db.query<{id:string;ready:boolean}>(`SELECT id,ready_until>clock_timestamp() AS ready FROM mas_business_agent WHERE id=ANY($1::uuid[]) ORDER BY id`,[[id(41),id(42)]])).rows;
    assert.deepEqual(readiness,[{id:id(41),ready:false},{id:id(42),ready:true}]);
    await handleAgentRequest(pool,principal(1),new Request('http://localhost/api/account/agents/'+id(42),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identityId:principal(1).id,expectedVersion:version+1,credentialId:'legacy'})}));
    await announce([{id:'legacy',profile:'dsh-text',kind:'api-key',label:'本机 DSH API Key'}]);
    await db.query(`INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,enabled,ready_until,ready_session_hash,name)
      VALUES($1,$2,$3,'codex-code',true,to_timestamp(0),$4,'Dual profile check')`,[id(47),id(31),id(1),'0'.repeat(64)]);
    await announceAgent(pool,new Request('http://localhost/api/runner/tasks/poll',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(31),sessionId,profile:'dsh-text',readyProfiles:['dsh-text','codex-code'],credentials:[{id:'legacy',profile:'dsh-text',kind:'api-key',label:'本机 DSH API Key'},{id:'legacy',profile:'codex-code',kind:'subscription',label:'本机 Codex 订阅'}],announceOnly:true})}),['dsh-text','codex-code']);
    assert.equal((await db.query<{count:number}>(`SELECT count(*)::int AS count FROM mas_business_runner_credential WHERE runner_id=$1 AND id='legacy'`,[id(31)])).rows[0].count,2);
    assert.equal((await db.query<{count:number}>(`SELECT count(*)::int AS count FROM mas_business_agent WHERE id=$1 AND ready_until>clock_timestamp()`,[id(47)])).rows[0].count,1);
    assert.equal((await listAgents(pool,principal(1))).agents.filter(a=>a.id===id(47)).length,1);
    await db.query('DELETE FROM mas_business_agent WHERE id=$1',[id(47)]);
  });

  await t.test('only the owning browser sees a current local Runner configuration endpoint',async()=>{
    const credential='a'.repeat(64),sessionId='b'.repeat(64),token='c'.repeat(64);
    await db.query(`UPDATE mas_business_runner_device SET credential_hash=$2,session_hash=$3,session_until=now()+interval '1 hour' WHERE id=$1`,
      [id(31),hashRunnerSecret(credential),hashRunnerSecret(sessionId)]);
    await announceAgent(pool,new Request('http://localhost/api/runner/tasks/poll',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(31),sessionId,profile:'dsh-text',readyProfiles:['dsh-text'],announceOnly:true,localConfig:{port:43123,token}})}),['dsh-text']);
    const path='http://localhost/api/account/runner-local-config/'+id(31);
    assert.deepEqual(await handleAgentRequest(pool,principal(1),new Request(path)),{identityId:'identity-1',runnerId:id(31),available:true,port:43123,token});
    assert.deepEqual(await handleAgentRequest(pool,principal(2),new Request(path)),{identityId:'identity-2',runnerId:id(31),available:false,port:null,token:null});
    const service=createAccountService({pool,origin:'https://scrum.example.test',identity:{principal:async()=>principal(1)} as unknown as IdentityService});
    for(const endpoint of [path,'http://localhost/api/account/runner-credentials']){
      const response=await service.handle(new Request(endpoint.replace('http://localhost','https://scrum.example.test')));
      assert.equal(response.status,200);
      assert.equal(response.headers.get('X-MAS-Identity'),principal(1).id);
      assert.equal((await response.json()).identityId,principal(1).id);
    }
    await db.query(`UPDATE mas_business_runner_device SET local_config_seen=now()-interval '20 seconds' WHERE id=$1`,[id(31)]);
    assert.equal((await handleAgentRequest(pool,principal(1),new Request(path)) as {available:boolean}).available,false);
  });

  await t.test('members see creator candidates only, outsiders cannot read and members cannot select',async()=>{
    const result=await get(2);assert.ok('agents' in result);
    assert.equal(result.ownerName,'Member 1');assert.deepEqual(result.agents.map((a:{id:string})=>a.id),[41,42,43,45,46].map(id));
    assert.deepEqual(Object.keys(result.agents[0]).sort(),['available','deviceName','effectiveModel','enabled','executorReady','id','model','modelReady','name','profile','readiness','revoked','runnerConnected']);
    await rejects(get(3),404);await rejects(set(41,0,2),403);await rejects(set(44,0),404);
    await rejects(set(45,0),403);await rejects(set(46,0),403);await rejects(set(41,0,1,false),403);
    assert.equal((await status()).rows.length,0);
  });
  await t.test('cards use the system catalog for models and the Runner only for readiness',async()=>{
    const read=async()=>{const result=await get();assert.ok('agents' in result);return result.agents.find((a:{id:string})=>a.id===id(41));};
    assert.equal((await read()).available,true);assert.equal((await read()).readiness,'ready');
    assert.equal((await read()).runnerConnected,true);assert.equal((await read()).executorReady,true);assert.equal((await read()).modelReady,true);
    await db.query("UPDATE mas_business_agent SET ready_until=now()-interval '1 second' WHERE id=$1",[id(41)]);
    assert.equal((await read()).runnerConnected,true);assert.equal((await read()).executorReady,false);assert.equal((await read()).readiness,'executor_unavailable');
    await db.query("UPDATE mas_business_agent SET ready_until=now()+interval '1 hour' WHERE id=$1",[id(41)]);
    await db.query('UPDATE mas_business_agent SET model=NULL WHERE id=$1',[id(41)]);
    await db.query(`UPDATE mas_business_runner_device SET session_hash=$2,session_until=now()+interval '1 hour' WHERE id=$1`,[id(31),'0'.repeat(64)]);
    await db.query("UPDATE mas_business_agent SET ready_until=now()+interval '1 hour',ready_session_hash=$2 WHERE id=$1",[id(41),'0'.repeat(64)]);
    assert.equal((await read()).available,true);assert.equal((await read()).effectiveModel,'deepseek-v4-pro');
    const personal=await listAgents(pool,principal(1));
    assert.equal(personal.agents.find(a=>a.id===id(41))?.effectiveModel,'deepseek-v4-pro');
    await db.query('UPDATE mas_business_agent SET model=$2 WHERE id=$1',[id(41),'deepseek-v4-pro']);
    assert.equal((await read()).effectiveModel,'deepseek-v4-pro');
    assert.equal((await read()).available,true);
    await db.query('UPDATE mas_business_agent SET model=$2 WHERE id=$1',[id(41),'missing-model']);
    assert.equal((await read()).available,false);assert.equal((await read()).readiness,'model_unavailable');
    assert.equal((await read()).runnerConnected,true);assert.equal((await read()).executorReady,true);assert.equal((await read()).modelReady,false);
    await db.query('UPDATE mas_business_agent SET model=NULL,enabled=false WHERE id=$1',[id(41)]);
    assert.equal((await read()).enabled,false);
    await db.query("UPDATE mas_business_runner_device SET session_until=now()-interval '1 second' WHERE id=$1",[id(31)]);
    assert.equal((await read()).available,false);assert.equal((await read()).readiness,'runner_offline');assert.equal((await read()).effectiveModel,'deepseek-v4-pro');
    assert.equal((await read()).runnerConnected,false);assert.equal((await read()).executorReady,false);assert.equal((await read()).modelReady,true);
    await db.query('UPDATE mas_business_agent SET enabled=true WHERE id=$1',[id(41)]);
  });
  await t.test('projects cannot create another board and the default board remains editable',async()=>{
    await rejects(mutateBoard(pool,principal(1).id,id(20),{kind:'create',name:'Another board',requestId:id(90)}),409);
    assert.equal((await db.query('SELECT id FROM mas_business_board WHERE project_id=$1',[id(20)])).rows.length,1);
    const renamed=await mutateBoard(pool,principal(1).id,id(20),{kind:'rename',boardId:id(21),name:'Scrum',requestId:id(91)});
    assert.equal(renamed.board.name,'Scrum');
  });
  await t.test('selection grants atomically, replay does not increment, switching leaves one coordinator',async()=>{
    await set(41,0);await set(41,0);
    assert.deepEqual((await status()).rows,[{agent_id:id(41),version:1}]);
    assert.deepEqual((await grant(41)).rows,[{enabled:true,version:1}]);
    await set(42,1);
    assert.deepEqual((await status()).rows,[{agent_id:id(42),version:2}]);
    await rejects(set(43,0),409);assert.equal((await grant(43)).rows.length,0);
    await db.query('UPDATE mas_business_agent_project SET enabled=false,version=version+1 WHERE agent_id=$1',[id(42)]);
    await rejects(set(42,1),403);
    assert.equal((await grant(42)).rows[0].enabled,false);
  });
  await t.test('failed coordinator persistence rolls back the newly authorized grant',async()=>{
    await db.exec(`CREATE FUNCTION reject_test_coordinator() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$;
      CREATE TRIGGER reject_test_coordinator BEFORE UPDATE ON mas_business_project_coordinator FOR EACH ROW EXECUTE FUNCTION reject_test_coordinator();`);
    await assert.rejects(set(43,2));
    assert.equal((await grant(43)).rows.length,0);
    assert.deepEqual((await status()).rows,[{agent_id:id(42),version:2}]);
    await db.exec('DROP TRIGGER reject_test_coordinator ON mas_business_project_coordinator');
  });
  await t.test('explicit personal Agents can be removed and history remains',async()=>{
    const removed=await handleAgentRequest(pool,principal(1),new Request('http://localhost/api/account/agents/'+id(45),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({identityId:principal(1).id})}));
    assert.deepEqual(removed,{identityId:principal(1).id,deleted:true});
    const result=await handleAgentRequest(pool,principal(1),new Request('http://localhost/api/account/agents/'+id(43),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({identityId:principal(1).id})}));
    assert.deepEqual(result,{identityId:principal(1).id,deleted:true});
    assert.equal((await listAgents(pool,principal(1)).then(value=>value.agents.some(agent=>agent.id===id(43)))),false);
    assert.equal((await db.query<{enabled:boolean}>('SELECT enabled FROM mas_business_agent WHERE id=$1',[id(43)])).rows[0].enabled,false);
    assert.ok((await db.query<{deleted_at:string|null}>('SELECT deleted_at FROM mas_business_agent WHERE id=$1',[id(43)])).rows[0].deleted_at);
  });
});
