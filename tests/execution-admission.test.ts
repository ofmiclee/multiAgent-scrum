import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {cloudIdentityConfig} from '../services/identity/cloud-config.ts';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import type {IdentityService} from '../services/identity/service.ts';
import {createAccountService} from '../services/account/service.ts';
import {hashRunnerSecret} from '../services/account/runner-connections.ts';
import {createStory} from '../services/account/stories.ts';
import {requestStoryAssistance} from '../services/account/story-assistance.ts';
import {handleDirectTaskRequest} from '../services/account/direct-tasks.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const production={NODE_ENV:'production',MAS_PUBLIC_ORIGIN:'https://scrum.fruitbuddy.cn',PORT:'8080',
  MAS_PG_SCHEMA:'mas_identity',MAS_PG_USER:'runtime',MAS_PG_PRIVATE_HOST:'10.0.0.1',MAS_PG_PORT:'5432',MAS_PG_DATABASE:'test',MAS_PG_PASSWORD:'test-only',
  MAS_PG_POOL_MAX:'2',MAS_PG_CONNECT_TIMEOUT_MS:'1000',MAS_PG_STATEMENT_TIMEOUT_MS:'1000',
  MAS_PG_TLS_CA_BASE64:Buffer.from('-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----').toString('base64'),
  MAS_IDENTITY_SECRET:'0123456789abcdef'.repeat(4),MAS_GITHUB_CLIENT_ID:'test',MAS_GITHUB_CLIENT_SECRET:'test',
  ENABLE_ACCOUNT_RUNNER_TASKS:'1',ENABLE_ACCOUNT_RUNNER_DSH_TASKS:'1',ENABLE_ACCOUNT_RUNNER_CODEX_TASKS:'1',
  ENABLE_ACCOUNT_RUNNER_EXECUTION:'1',ENABLE_ACCOUNT_STORY_ASSISTANCE:'1'};

for(const legacyList of [undefined,id(999)])test(`production dispatch uses project authorization with ${legacyList?'obsolete':'no'} project list`,async t=>{
  const config=cloudIdentityConfig({...production,...(legacyList?{MAS_EXECUTION_PROJECT_IDS:legacyList}:{})});
  const db=new PGlite();t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  const pool={connect:async()=>({query:async(sql:string,args?:unknown[])=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};},release(){}})} as unknown as Pool;
  const principal={id:'owner',name:'Owner'},credential='a'.repeat(64),sessionId='b'.repeat(64);
  await db.query('INSERT INTO mas_identity_user(id,name,email,"createdAt","updatedAt") VALUES($1,$2,$3,now(),now())',[principal.id,principal.name,'owner@example.test']);
  await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(1),principal.id,principal.name]);
  await db.query('INSERT INTO mas_business_organization(id,name,created_by) VALUES($1,$2,$3)',[id(10),'Team',id(1)]);
  await db.query("INSERT INTO mas_business_membership(organization_id,user_id,role) VALUES($1,$2,'owner')",[id(10),id(1)]);
  await db.query("INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash,session_hash,session_until) VALUES($1,$2,'Runner',$3,$4,now()+interval '1 hour')",[id(30),id(1),hashRunnerSecret(credential),hashRunnerSecret(sessionId)]);
  await db.query("INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,name,enabled,ready_until,ready_session_hash) VALUES($1,$2,$3,'dsh-text','Coordinator',true,to_timestamp(0),$4)",[id(40),id(30),id(1),hashRunnerSecret(sessionId)]);
  const app=createAccountService({...config,pool,identity:{principal:async()=>principal} as unknown as IdentityService});
  async function poll(profile='dsh-text'){
    return app.handle(new Request(config.origin+'/api/runner/tasks/poll',{method:'POST',headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify({runnerId:id(30),sessionId,profile})}));
  }
  for(const [project,kind] of [[20,'task'],[22,'story']] as const){
    await db.exec('BEGIN');
    await db.query('INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id) VALUES($1,$2,$3,$4,$5)',[id(project),id(10),kind,id(1),id(project+1)]);
    await db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(project+1),id(project),'Board']);await db.exec('COMMIT');
    await db.query("INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role) VALUES($1,$2,$3,'owner')",[id(project),id(10),id(1)]);
    await db.query('INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled) VALUES($1,$2,$3,true)',[id(40),id(1),id(project)]);
    await db.query('INSERT INTO mas_business_project_coordinator(project_id,owner_id,agent_id) VALUES($1,$2,$3)',[id(project),id(1),id(40)]);
    let taskId:string;
    if(kind==='story'){
      const {story}=await createStory(pool,principal.id,id(project),id(project+1),{title:'Split this story',body:'Write a guide',requestId:id(100+project)});
      taskId=story.id;await requestStoryAssistance(pool,principal.id,id(project),story.id,{expectedVersion:1,requestId:id(200+project)});
    }else taskId=(await handleDirectTaskRequest(pool,principal,new Request(config.origin+'/api/account/projects/'+id(project)+'/boards/'+id(project+1)+'/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({body:'Write a guide',requestId:id(100+project)})}))).taskId;
    for(const [table,column,blocked,restored,status] of [
      ['mas_business_agent_project','enabled','false','true',200],
      ['mas_business_project_member','status',"'suspended'","'active'",200],
      ['mas_business_membership','status',"'suspended'","'active'",200],
      ['mas_business_agent','enabled','false','true',200],
      ['mas_business_project_coordinator','paused','true','false',200],
      ['mas_business_runner_device','revoked_at','now(),session_hash=NULL,session_until=NULL',"NULL,session_until=now()+interval '1 hour',session_hash='"+hashRunnerSecret(sessionId)+"'",403],
      ['mas_business_runner_device','session_until','to_timestamp(0)',"now()+interval '1 hour'",409],
    ] as const){
      await db.exec(`UPDATE ${table} SET ${column}=${blocked}`);
      const response=await poll();assert.equal(response.status,status,kind+': '+table+'.'+column);
      if(status===200)assert.equal(await response.json(),null);
      await db.exec(`UPDATE ${table} SET ${column}=${restored}`);
    }
    const response=await poll();assert.equal(response.status,200);
    const offered=await response.json();assert.equal(offered?.taskId,taskId,kind+' should be dispatched without project registration');
    assert.deepEqual(await (await poll()).json(),offered,'existing attempts must be reconciled');
    assert.equal(await (await poll('codex-code')).json(),null,'another profile cannot take active work');
    // Free this fixture's capacity before checking the other dispatch path.
    await db.query("UPDATE mas_business_work_attempt SET state='stopped',finished_at=clock_timestamp() WHERE id=$1",[offered.attemptId]);
    await db.exec("UPDATE mas_business_work SET state='failed'; UPDATE mas_business_story_assistance SET state='failed'");
  }
});
