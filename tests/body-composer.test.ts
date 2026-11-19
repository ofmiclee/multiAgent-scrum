import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer,request as httpRequest} from 'node:http';
import {randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import sharp from 'sharp';
import type {Pool,PoolClient} from 'pg';
import type {IdentityService} from '../services/identity/service.ts';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import {createAccountService} from '../services/account/service.ts';
import {createIdentityHttpHandler} from '../services/identity/http.ts';
import {bodyImageUploadLimit,bodyImageUploadPath} from '../services/account/body-images.ts';
import {bodyImageUrl} from '../packages/domain/body-images.ts';
import {startWork,finishWork} from '../services/account/execution-store.ts';
import {projectTransaction} from '../services/account/project-scope.ts';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('single-step story and direct-task creation preserve image access and task semantics',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  const query=async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0};};
  const client={query,release(){}} as unknown as PoolClient,pool={query,connect:async()=>client} as unknown as Pool;
  for(let n=1;n<=4;n++){
    await db.query('INSERT INTO mas_identity_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())',['identity-'+n,'User '+n,n+'@example.test']);
    await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',[id(n),'identity-'+n,'User '+n]);
  }
  await db.query('INSERT INTO mas_business_organization(id,name,created_by) VALUES($1,$2,$3)',[id(10),'Team',id(1)]);
  for(const n of [1,2,3])await db.query('INSERT INTO mas_business_membership(organization_id,user_id,role) VALUES($1,$2,$3)',[id(10),id(n),n===1?'owner':'member']);
  for(const n of [20,30]){
    await db.exec('BEGIN');await db.query('INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id) VALUES($1,$2,$3,$4,$5)',[id(n),id(10),'Project',id(1),id(n+1)]);
    await db.query('INSERT INTO mas_business_board(id,project_id,name) VALUES($1,$2,$3)',[id(n+1),id(n),'Board']);await db.exec('COMMIT');
    for(const u of [1,2,3])await db.query('INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role) VALUES($1,$2,$3,$4)',[id(n),id(10),id(u),u===1?'owner':u===2?'member':'viewer']);
  }
  let actor:number|null=1;
  const identity={principal:async()=>actor?{id:'identity-'+actor,name:'User '+actor}:null} as unknown as IdentityService;
  const origin='http://127.0.0.1:5198',app=createAccountService({pool,identity,origin});
  const call=(path:string,body?:object)=>app.handle(new Request(origin+'/api/account'+path,body?{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{}));
  const project='/projects/'+id(20),board=project+'/boards/'+id(21);
  const png=await sharp({create:{width:20,height:20,channels:3,background:'#20a080'}}).png().toBuffer();
  const imageBody={id:id(100),data:png.toString('base64')},body='正文\n![图片]('+bodyImageUrl(id(20),id(100))+')';
  await t.test('uploads decode raster images, strip metadata, and round-trip binary HTTP',async()=>{
    assert.equal((await call(project+'/body-images',imageBody)).status,200);
    assert.equal((await call(project+'/body-images',imageBody)).status,200);
    assert.equal((await call(project+'/body-images',{...imageBody,data:Buffer.from('<svg/>').toString('base64')})).status,409);
    assert.equal((await call(project+'/body-images',{id:id(101),data:Buffer.from('<svg/>').toString('base64')})).status,400);
    const image=await call(project+'/body-images/'+id(100));assert.equal(image.headers.get('content-type'),'image/webp');
    const stored=Buffer.from(await image.arrayBuffer());assert.equal((await sharp(stored).metadata()).width,20);
    const largePng=await sharp(randomBytes(1800*1800*3),{raw:{width:1800,height:1800,channels:3}}).png({compressionLevel:0}).toBuffer();
    assert.ok(largePng.length>9*1024*1024&&largePng.length<10*1024*1024);
    assert.equal((await call(project+'/body-images',{id:id(102),data:largePng.toString('base64')})).status,200);
    assert.equal((await call(project+'/body-images',{id:id(103),data:Buffer.alloc(10*1024*1024+1).toString('base64')})).status,413);
    const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
    const address=server.address();assert.ok(address&&typeof address!=='string');const local='http://127.0.0.1:'+address.port;
    const binaryHandler=createIdentityHttpHandler({handle:async request=>request.method==='POST'?Response.json({size:(await request.text()).length}):new Response(new Uint8Array(stored),{headers:{'Content-Type':'image/webp'}})},local,{bodyImages:true,bodyLimit:target=>bodyImageUploadPath(target.pathname)?bodyImageUploadLimit:16384});
    server.on('request',binaryHandler);
    assert.deepEqual(Buffer.from(await (await fetch(local+'/image')).arrayBuffer()),stored);
    const large=JSON.stringify({data:'x'.repeat(110000)}),uploadPath='/api/account'+project+'/body-images';
    assert.equal((await fetch(local+uploadPath,{method:'POST',body:large})).status,200);
    assert.equal((await fetch(local+'/api/identity/sign-in/email',{method:'POST',body:large})).status,413);
    assert.equal((await fetch(local+uploadPath+'/invalid',{method:'POST',body:large})).status,413);
    // The server rejects oversized Content-Length before reading the body.
    // Avoid a client upload/connection-close race when asserting that response.
    const rejectedStatus=await new Promise<number|undefined>((resolve,reject)=>{
      const request=httpRequest(local+uploadPath,{method:'POST',headers:{'Content-Length':bodyImageUploadLimit+1}},response=>{response.resume();resolve(response.statusCode);});
      request.on('error',reject);request.end();
    });
    assert.equal(rejectedStatus,413);
  });
  await t.test('drafts are private; Story publication binds images and retries do not duplicate',async()=>{
    actor=2;assert.equal((await call(project+'/body-images/'+id(100))).status,404);
    assert.equal((await call(board+'/stories',{title:'Other draft',body,requestId:id(110)})).status,400);
    actor=1;const input={title:'Story',body,requestId:id(111)};
    const response=await call(board+'/stories',input);assert.equal(response.status,200);const first=await response.json();
    assert.deepEqual(await (await call(board+'/stories',input)).json(),first);
    assert.equal((await call(board+'/stories',{...input,title:'Changed'})).status,409);
    actor=2;assert.equal((await call(project+'/body-images/'+id(100))).status,200);
    assert.equal((await call('/projects/'+id(30)+'/boards/'+id(31)+'/stories',{title:'Cross project',body,requestId:id(112)})).status,400);
  });
  let taskId:string;
  await t.test('direct tasks have no title or Story, start pending, and remain visible on task routes',async()=>{
    const input={body,requestId:id(120)};
    const response=await call(board+'/tasks',input);assert.equal(response.status,200);const created=await response.json();taskId=created.taskId;
    assert.deepEqual(await (await call(board+'/tasks',input)).json(),created);
    assert.equal((await call(board+'/tasks',{...input,body:'changed'})).status,409);
    assert.equal((await call(board+'/tasks',{body:' ',requestId:id(121)})).status,400);
    assert.equal((await call(board+'/tasks',{body:'x'.repeat(4001),requestId:id(122)})).status,400);
    const task=(await db.query<{title:string;source:string;status:string;story_id:string|null;story_version:number|null;required_capabilities:string[]}>('SELECT t.*,p.story_id,p.story_version FROM mas_business_task t JOIN mas_business_task_publication p ON p.id=t.publication_id WHERE t.id=$1',[taskId])).rows[0];
    assert.equal(task.title,'');assert.equal(task.source,'direct');assert.equal(task.status,'pending');assert.equal(task.story_id,null);assert.equal(task.story_version,null);assert.deepEqual(task.required_capabilities,[]);
    assert.equal((await db.query('SELECT id FROM mas_business_story')).rows.length,1);
    const listed=await (await call(project+'/tasks')).json();assert.equal(listed.tasks[0].id,taskId);assert.equal(listed.tasks[0].objective,body);
    assert.equal((await call(board+'/tasks/'+taskId)).status,200);
  });
  await t.test('titleless tasks are assessed and executed through existing leases and human acceptance',async()=>{
    actor=1;
    const plain=await (await call(board+'/tasks',{body:'撰写发布说明',requestId:id(140)})).json();
    await db.query('INSERT INTO mas_business_runner_device(id,owner_id,name,credential_hash) VALUES($1,$2,$3,$4)',[id(200),id(1),'Test runner','0'.repeat(64)]);
    await db.query("INSERT INTO mas_business_agent(id,runner_id,owner_id,profile,enabled,ready_until,ready_session_hash,name) VALUES($1,$2,$3,'dsh-text',true,now()+interval '1 hour',$4,'Test agent')",[id(201),id(200),id(1),'0'.repeat(64)]);
    await db.query('INSERT INTO mas_business_agent_project(agent_id,owner_id,project_id,enabled) VALUES($1,$2,$3,true)',[id(201),id(1),id(20)]);
    await db.query('INSERT INTO mas_business_project_coordinator(project_id,owner_id,agent_id) VALUES($1,$2,$3)',[id(20),id(1),id(201)]);
    const context={user:{id:id(1),identity_id:'identity-1',status:'active'},device:{id:id(200),session_until:new Date(Date.now()+3600000)}} as Parameters<typeof startWork>[1];
    const result={summary:JSON.stringify({difficulty:1,risk:'low',confidence:0.95,rationale:'Writing task',requiredCapability:'writing'}),artifacts:[],checksPassed:false as const,nativeSession:{threadId:'test-thread',turnId:'test-turn'}};
    for(const [i,task] of [taskId,plain.taskId].entries()){
      await db.query("INSERT INTO mas_business_work(id,task_id,kind,state,calls) VALUES($1,$2,'assess','active',1)",[id(210+i),task]);
      await db.query("INSERT INTO mas_business_work_attempt(id,work_id,agent_id,runner_id,owner_id,fence,coordinator_version,state,lease_until) VALUES($1,$2,$3,$4,$5,1,1,'assigned',now()+interval '1 hour')",[id(220+i),id(210+i),id(201),id(200),id(1)]);
      const ref={taskId:task,attemptId:id(220+i),fence:1};
      const input=await projectTransaction(pool,c=>startWork(c,context,ref,'dsh-text'));
      if(i===0)assert.match(input.description,/cannot inspect these private images/);
      await projectTransaction(pool,c=>finishWork(c,context,ref,result));
      await projectTransaction(pool,c=>finishWork(c,context,ref,result));
      const assessment=(await db.query<{approved:boolean}>('SELECT approved FROM mas_business_work WHERE id=$1',[id(210+i)])).rows[0];
      assert.equal(assessment.approved,i===1);
      assert.deepEqual((await db.query<{required_capabilities:string[]}>('SELECT required_capabilities FROM mas_business_task WHERE id=$1',[task])).rows[0].required_capabilities,['writing']);
    }
    const work=(await db.query<{id:string}>("SELECT id FROM mas_business_work WHERE task_id=$1 AND kind='execute'",[plain.taskId])).rows[0];
    await db.query("UPDATE mas_business_work SET state='active',calls=1 WHERE id=$1",[work.id]);
    await db.query("INSERT INTO mas_business_work_attempt(id,work_id,agent_id,runner_id,owner_id,fence,state,lease_until) VALUES($1,$2,$3,$4,$5,1,'assigned',now()+interval '1 hour')",[id(230),work.id,id(201),id(200),id(1)]);
    const ref={taskId:plain.taskId,attemptId:id(230),fence:1};
    const input=await projectTransaction(pool,c=>startWork(c,context,ref,'dsh-text'));assert.equal(input.title,'');assert.match(input.description,/撰写发布说明/);
    await projectTransaction(pool,c=>finishWork(c,context,ref,{...result,summary:'Release notes delivered'}));
    assert.equal((await db.query<{status:string}>('SELECT status FROM mas_business_task WHERE id=$1',[plain.taskId])).rows[0].status,'review');
    assert.equal((await call(project+'/tasks/'+plain.taskId+'/review',{identityId:'identity-1',attemptId:id(230),decision:'accept',feedback:'人工核对通过'})).status,200);
    assert.equal((await db.query<{status:string}>('SELECT status FROM mas_business_task WHERE id=$1',[plain.taskId])).rows[0].status,'done');
  });
  await t.test('viewer, outsiders, removed members, invalid boards and expired drafts cannot mutate or leak images',async()=>{
    actor=3;assert.equal((await call(board+'/tasks',{body:'task',requestId:id(130)})).status,403);assert.equal((await call(project+'/body-images',{...imageBody,id:id(131)})).status,403);
    assert.equal((await call(project+'/body-images/'+id(100))).status,200);
    actor=4;assert.equal((await call(project+'/body-images/'+id(100))).status,404);
    actor=2;await db.query("UPDATE mas_business_membership SET status='suspended' WHERE user_id=$1",[id(2)]);
    assert.equal((await call(project+'/body-images/'+id(100))).status,403);
    assert.equal((await call(board+'/tasks',{body,requestId:id(120)})).status,403);
    actor=1;assert.equal((await call(project+'/boards/'+id(31)+'/tasks',{body:'task',requestId:id(132)})).status,404);
    assert.equal((await call(project+'/body-images',{...imageBody,id:id(133)})).status,200);
    await db.query("UPDATE mas_business_body_image SET created_at=now()-interval '25 hours' WHERE id=$1",[id(133)]);
    assert.equal((await call(project+'/body-images/'+id(133))).status,404);
    assert.equal((await call(board+'/tasks',{body:'![图片]('+bodyImageUrl(id(20),id(133))+')',requestId:id(134)})).status,400);
    actor=null;assert.equal((await call(project+'/body-images/'+id(100))).status,401);
    actor=1;assert.equal((await app.handle(new Request(origin+'/api/account'+board+'/tasks',{method:'POST',headers:{origin:'https://outside.test','Content-Type':'application/json'},body:JSON.stringify({body:'text',requestId:id(135)})}))).status,403);
  });
});
