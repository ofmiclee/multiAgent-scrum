import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import sharp from 'sharp';
import type {Pool,PoolClient} from 'pg';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import {handleInviteLinkRequest} from '../services/account/invite-links.ts';
import {handleOrganizationRequest} from '../services/account/organization-routes.ts';
import {changeProjectMember,listOrganizationMembers,listProjectMembers} from '../services/account/members.ts';
import {authorizeProject,projectTransaction} from '../services/account/project-scope.ts';
import {createAccountService} from '../services/account/service.ts';
import {handleProjectCommand} from '../services/account/projects.ts';
import type {IdentityService} from '../services/identity/service.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const principal=(n:number)=>({id:'identity-'+n,name:'Member '+n});
const request=(path:string,body?:object)=>new Request('http://127.0.0.1:5198/api/account'+path,body?{method:'POST',headers:{'Content-Type':'application/json',origin:'http://127.0.0.1:5198'},body:JSON.stringify(body)}:{});
const rejects=(promise:Promise<unknown>,code:number)=>assert.rejects(promise,error=>error===code);

test('membership and invitation rules execute against migrated PostgreSQL',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  const query=async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.affectedRows??result.rows.length};};
  const client={query,release(){}} as unknown as PoolClient;
  const pool={query,connect:async()=>client} as unknown as Pool;
  for(let n=1;n<=9;n++){
    await db.query('INSERT INTO mas_identity_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',[principal(n).id,principal(n).name,n+'@example.test']);
    await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(n),principal(n).id,principal(n).name]);
  }
  await db.query('INSERT INTO mas_business_organization(id,name,created_by) VALUES($1,$2,$3)',[id(10),'Team',id(1)]);
  for(const n of [1,2,3])await db.query('INSERT INTO mas_business_membership(organization_id,user_id,role) VALUES($1,$2,$3)',[id(10),id(n),n===1?'owner':'member']);
  await db.exec('BEGIN');
  await db.query('INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id) VALUES($1,$2,$3,$4,$5)',[id(20),id(10),'Project',id(1),id(21)]);
  await db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(21),id(20),'Board']);await db.exec('COMMIT');
  for(const n of [1,2])await db.query('INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role) VALUES($1,$2,$3,$4)',[id(20),id(10),id(n),n===1?'owner':'manager']);
  const org='/organizations/'+id(10),project=id(20);
  const invoke=(actor:number,path:string,body:object)=>handleInviteLinkRequest(pool,principal(actor),request(path,body));
  const orgCommand=(actor:number,path:string,body:object)=>handleOrganizationRequest(pool,principal(actor),request(path,body));
  const create=(actor:number,n:number,maxUses=1,hours=24)=>invoke(actor,org+'/invite-links',{token:n.toString(16).padStart(64,'0'),requestId:id(100+n),maxUses,hours});
  const accept=(actor:number,n:number)=>invoke(actor,'/invitation-links/accept',{token:n.toString(16).padStart(64,'0')});
  const add=(actor:number,n:number,receipt=200+n)=>invoke(actor,org+'/members/add',{email:n+'@example.test',requestId:id(receipt)});
  const change=(actor:number,n:number,version:number,role:'manager'|'member'|'viewer')=>changeProjectMember(pool,principal(actor).id,project,{userId:id(n),status:'active',expectedVersion:version,role});

  await t.test('organization creator receives the project-list identity response',async()=>{
    // PGlite reports affectedRows=0 for SELECT. The pg-compatible service
    // expects rowCount to be the selected row count, as PostgreSQL returns.
    const projectQuery=async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.rows.length};};
    const projectClient={query:projectQuery,release(){}} as unknown as PoolClient;
    const projectPool={query:projectQuery,connect:async()=>projectClient} as unknown as Pool;
    const service=createAccountService({pool:projectPool,identity:{principal:async()=>principal(1)} as unknown as IdentityService,origin:'http://127.0.0.1:5198'});
    const response=await service.handle(request(org+'/projects'));
    assert.equal(response.status,200);assert.equal(response.headers.get('x-mas-identity'),principal(1).id);
    assert.equal((await response.json()).projects.length,1);
  });
  await t.test('four project roles enforce owner, manager, viewer and organization scope',async()=>{
    await change(2,3,0,'viewer');
    assert.equal((await listProjectMembers(pool,principal(3).id,project)).members.length,3);
    await projectTransaction(pool,c=>authorizeProject(c,principal(3).id,project,false));
    await rejects(projectTransaction(pool,c=>authorizeProject(c,principal(3).id,project,true)),403);
    const service=createAccountService({pool,identity:{principal:async()=>principal(3)} as unknown as IdentityService,origin:'http://127.0.0.1:5198'});
    for(const [path,body] of [
      ['/projects/'+project+'/boards/'+id(21)+'/stories',{title:'Forbidden',body:'Read only',requestId:id(800)}],
      ['/projects/'+project+'/tasks/'+id(801)+'/comments',{identityId:principal(3).id,requestId:id(802),body:'Forbidden'}],
      ['/projects/'+project+'/tasks/'+id(801)+'/review',{identityId:principal(3).id,attemptId:id(802),decision:'accept',feedback:'Forbidden'}],
    ] as const)assert.equal((await service.handle(request(path,body))).status,403);
    await rejects(change(3,2,1,'member'),403);await rejects(change(2,3,1,'manager'),403);
    await rejects(change(2,1,1,'member'),403);await rejects(change(2,2,1,'manager'),403);
    await rejects(change(1,4,0,'member'),404);await change(2,3,1,'member');
    const listed=await listOrganizationMembers(pool,principal(2).id,id(10));assert.equal(listed.members.length,3);
  });
  await t.test('creator can add a verified account, members cannot; replay is harmless',async()=>{
    await rejects(add(2,4),403);await rejects(add(1,90),404);await add(1,4);await add(1,4);
    assert.equal((await db.query('SELECT * FROM mas_business_membership WHERE user_id=$1',[id(4)])).rows.length,1);
    await orgCommand(1,org+'/members',{userId:id(4),status:'suspended',expectedVersion:1});
    await rejects(add(1,4),409);await add(1,4,904);
  });
  await t.test('owner links are bounded, hashed, replayable and do not grant project access',async()=>{
    const result=await create(1,1);assert.ok('link' in result);assert.equal(result.link.approvalRequired,false);
    await create(1,1);await rejects(create(1,1,2),409);
    assert.deepEqual(await accept(5,1),{status:'joined'});assert.deepEqual(await accept(5,1),{status:'joined'});
    await rejects(accept(6,1),409);await rejects(listProjectMembers(pool,principal(5).id,project),404);
    const row=(await db.query<{uses:number;token_hash:string}>('SELECT uses,token_hash FROM mas_business_invite_link WHERE request_id=$1',[id(101)])).rows[0];
    assert.equal(row.uses,1);assert.notEqual(row.token_hash,'1'.padStart(64,'0'));
    await rejects(accept(6,999),404);
  });
  await t.test('member links reserve a slot and require creator approval',async()=>{
    await create(2,2);assert.deepEqual(await accept(6,2),{status:'pending'});assert.deepEqual(await accept(6,2),{status:'pending'});
    assert.equal((await db.query('SELECT * FROM mas_business_membership WHERE user_id=$1',[id(6)])).rows.length,0);
    await rejects(accept(7,2),409);
    const application=(await db.query<{id:string}>('SELECT id FROM mas_business_join_request WHERE user_id=$1',[id(6)])).rows[0];
    await rejects(orgCommand(2,org+'/join-requests/'+application.id,{decision:'approve'}),403);
    const rows=await handleOrganizationRequest(pool,principal(1),request(org+'/join-requests'));assert.ok('requests' in rows&&rows.requests);assert.equal(rows.requests[0].invitedBy,'Member 2');
    await orgCommand(1,org+'/join-requests/'+application.id,{decision:'approve'});
    assert.deepEqual(await accept(6,2),{status:'joined'});
  });
  await t.test('expiry, rejected applications and revoked issuers cannot be bypassed',async()=>{
    await create(2,3,2);await accept(7,3);
    const application=(await db.query<{id:string}>('SELECT id FROM mas_business_join_request WHERE user_id=$1',[id(7)])).rows[0];
    await orgCommand(1,org+'/join-requests/'+application.id,{decision:'reject'});assert.deepEqual(await accept(7,3),{status:'rejected'});
    await create(2,4);await accept(8,4);
    await db.query("UPDATE mas_business_invite_link SET expires_at=now()-interval '1 second' WHERE request_id=$1",[id(104)]);
    const expired=(await db.query<{id:string}>('SELECT id FROM mas_business_join_request WHERE user_id=$1',[id(8)])).rows[0];
    await rejects(orgCommand(1,org+'/join-requests/'+expired.id,{decision:'approve'}),404);await rejects(accept(9,4),404);
    await create(2,5);await accept(9,5);
    const pending=(await db.query<{id:string}>('SELECT id FROM mas_business_join_request WHERE user_id=$1',[id(9)])).rows[0];
    await db.query('INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash) VALUES($1,$2,$3,$4)',[id(30),id(2),'Runner','0'.repeat(64)]);
    await db.query("INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,name,ready_until,ready_session_hash) VALUES($1,$2,$3,'dsh-text','Agent',to_timestamp(0),$4)",[id(31),id(30),id(2),'0'.repeat(64)]);
    await db.query('INSERT INTO mas_business_agent_project(agent_id,project_id,owner_id,enabled) VALUES($1,$2,$3,true)',[id(31),project,id(2)]);
    await orgCommand(1,org+'/members',{userId:id(2),status:'suspended',expectedVersion:1});
    await rejects(listOrganizationMembers(pool,principal(2).id,id(10)),403);await rejects(listProjectMembers(pool,principal(2).id,project),403);
    await rejects(handleProjectCommand(pool,principal(2).id,{kind:'list',organizationId:id(10)}),404);
    await rejects(handleProjectCommand(pool,principal(2).id,{kind:'detail',projectId:project}),404);
    assert.equal((await db.query<{enabled:boolean}>('SELECT enabled FROM mas_business_agent_project WHERE agent_id=$1',[id(31)])).rows[0].enabled,false);
    await rejects(orgCommand(1,org+'/join-requests/'+pending.id,{decision:'approve'}),404);
    await add(1,2);await rejects(listProjectMembers(pool,principal(2).id,project),404);await rejects(accept(9,5),404);
    await rejects(orgCommand(1,org+'/members',{userId:id(1),status:'suspended',expectedVersion:1}),403);
  });
  await t.test('organization display name is required and avatar is private, bounded and versioned',async()=>{
    const png=await sharp({create:{width:480,height:320,channels:3,background:'#5a817f'}}).png().toBuffer();
    await rejects(orgCommand(2,org,{alias:'成员改名',description:'',expectedVersion:1}),403);
    await assert.rejects(orgCommand(1,org,{alias:'',description:'',expectedVersion:1}),error=>error instanceof Error&&error.name==='ZodError');
    const updated=await orgCommand(1,org,{slug:'pomona',alias:'水果女神',description:'水果伙伴组织',expectedVersion:1,avatar:png.toString('base64')});
    assert.ok('organization'in updated);assert.equal(updated.organization.alias,'水果女神');assert.equal(updated.organization.slug,'pomona');
    assert.equal(updated.organization.image,'/api/account/organizations/'+id(10)+'/avatar/2');
    const avatarRequest=new Request('http://127.0.0.1:5198'+updated.organization.image);
    const avatar=await handleOrganizationRequest(pool,principal(2),avatarRequest);assert.ok(avatar instanceof Response);
    assert.equal(avatar.headers.get('content-type'),'image/webp');
    const metadata=await sharp(Buffer.from(await avatar.arrayBuffer())).metadata();assert.equal(metadata.width,256);assert.equal(metadata.height,256);
    await rejects(handleOrganizationRequest(pool,principal(9),avatarRequest),404);
    await rejects(handleOrganizationRequest(pool,principal(1),new Request('http://127.0.0.1:5198/api/account/organizations/'+id(10)+'/avatar/1')),404);
  });
  await t.test('HTTP integration authenticates and enforces same-origin for links',async()=>{
    let signedIn=true;
    const identity={principal:async()=>signedIn?principal(1):null} as unknown as IdentityService;
    const service=createAccountService({pool,identity,origin:'http://127.0.0.1:5198'});
    const account=await service.handle(request('/me'));assert.equal(account.status,200);
    const accountBody=await account.json();const organization=accountBody.organizations.find((item:{id:string})=>item.id===id(10));
    assert.equal(organization.alias,'水果女神');assert.equal(organization.slug,'pomona');assert.equal(organization.image,'/api/account/organizations/'+id(10)+'/avatar/2');
    const avatar=await service.handle(new Request('http://127.0.0.1:5198'+organization.image));
    assert.equal(avatar.status,200);assert.equal(avatar.headers.get('content-type'),'image/webp');assert.equal(avatar.headers.get('cache-control'),'no-store');
    const invalidOrganization=request('/organizations',{name:'missing-display-name',requestId:id(998)});
    assert.equal((await service.handle(invalidOrganization)).status,400);
    const body={token:'a'.repeat(64),requestId:id(999),maxUses:1,hours:1};
    const good=request(org+'/invite-links',body);assert.equal((await service.handle(good)).status,200);
    const cross=request(org+'/invite-links',body);cross.headers.set('origin','https://other.test');assert.equal((await service.handle(cross)).status,403);
    signedIn=false;assert.equal((await service.handle(request(org+'/invite-links',body))).status,401);
  });
});
