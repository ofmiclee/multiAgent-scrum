import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import sharp from 'sharp';
import type {Pool,PoolClient} from 'pg';
import {localIdentityMigrations} from '../services/identity/local-runtime.ts';
import {createIdentityService} from '../services/identity/service.ts';
import {createAccountService} from '../services/account/service.ts';
import {githubAvatar,readPersonalProfile} from '../services/identity/profile.ts';
import {githubTransport} from '../services/identity/github-transport.ts';
import {createAccountWebHandler} from '../services/account/web.ts';

test('GitHub transport preserves provider avatar, display name and login fallback',async t=>{
  let name:string|null='GitHub 用户';
  t.mock.method(globalThis,'fetch',async(input:string)=>Response.json(input.endsWith('/emails')?[{email:'github@example.test',primary:true,verified:true}]:{id:123,login:'github-login',name,email:null,avatar_url:'https://avatars.githubusercontent.com/u/123?v=4'}));
  const plugin=githubTransport({credentials:{clientId:'test',clientSecret:'test'},signal:()=>new AbortController().signal,diagnose(){}});
  const init=plugin.init as unknown as (context:unknown)=>{context:{socialProviders:{getUserInfo:(token:unknown)=>Promise<{user:{name:string;image:string;emailVerified:boolean}}> }[]}};
  const provider=init({socialProviders:[{id:'github'}]}).context.socialProviders[0];
  const profile=await provider.getUserInfo({accessToken:'test'});
  assert.equal(profile.user.name,'GitHub 用户');assert.equal(profile.user.image,'https://avatars.githubusercontent.com/u/123?v=4');assert.equal(profile.user.emailVerified,true);
  name=null;assert.equal((await provider.getUserInfo({accessToken:'test'})).user.name,'github-login');
});

test('personal profiles use real sessions, keep edits across provider refresh, and isolate avatars',async t=>{
  const db=new PGlite();t.after(()=>db.close());
  for(const file of localIdentityMigrations)await db.exec(await readFile(new URL('../services/identity/migrations/'+file,import.meta.url),'utf8'));
  const query=async(sql:string,args?:unknown[])=>{const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows||0};};
  const client={query,release(){}} as unknown as PoolClient,pool={query,connect:async()=>client} as unknown as Pool;
  const origin='http://127.0.0.1:5198';
  const identity=createIdentityService({pool,origin,secret:randomBytes(32).toString('hex')});
  const password='Isolated-test-password-123';
  const first=await identity.provision({email:'first@example.test',name:'GitHub 昵称',password});
  const second=await identity.provision({email:'second@example.test',name:'其他用户',password});
  await db.query('UPDATE mas_identity_user SET image=$2 WHERE id=$1',[first.id,'https://avatars.githubusercontent.com/u/123?v=4']);
  async function login(email:string){
    const response=await identity.handle(new Request(origin+'/api/identity/sign-in/email',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({email,password})}));
    assert.equal(response.status,200);
    return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  }
  const firstCookie=await login('first@example.test'),secondCookie=await login('second@example.test');let cookie=firstCookie;
  const app=createAccountService({pool,identity,origin});
  const call=(path='/profile',body?:object,originHeader=origin)=>app.handle(new Request(origin+'/api/account'+path,{headers:{cookie,origin:originHeader,'Content-Type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})}));
  const session=()=>identity.handle(new Request(origin+'/api/identity/session',{headers:{cookie}}));
  let imagePath:string;
  await t.test('session exposes the GitHub avatar and nickname without tokens',async()=>{
    const response=await session();assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{user:{id:first.id,name:'GitHub 昵称',image:'https://avatars.githubusercontent.com/u/123?v=4',signature:'',version:0}});
    for(const url of ['http://avatars.githubusercontent.com/u/1','https://evil.test/avatar','https://avatars.githubusercontent.com.evil.test/u/1','https://x@avatars.githubusercontent.com/u/1','javascript:alert(1)'])assert.equal(githubAvatar(url),null);
  });
  await t.test('own profile can be saved before joining an organization; image is decoded and bounded',async()=>{
    const png=await sharp({create:{width:480,height:320,channels:3,background:'#218876'}}).png().toBuffer();
    const saved=await call('/profile',{name:'我的昵称',signature:'一起做好产品',version:0,avatar:png.toString('base64')});assert.equal(saved.status,200);
    const {user}=await saved.json();imagePath=user.image;assert.equal(user.version,1);
    const avatar=await call(imagePath.replace('/api/account',''));assert.equal(avatar.status,200);assert.equal(avatar.headers.get('cache-control'),'no-store');assert.equal(avatar.headers.get('content-type'),'image/webp');
    const info=await sharp(Buffer.from(await avatar.arrayBuffer())).metadata();assert.equal(info.width,256);assert.equal(info.height,256);assert.equal(info.exif,undefined);
    assert.equal((await db.query('SELECT id FROM mas_business_user')).rows.length,0);
    await db.query('UPDATE mas_identity_user SET name=$2,image=$3 WHERE id=$1',[first.id,'新 GitHub 名称','https://avatars.githubusercontent.com/u/456']);
    assert.deepEqual((await (await session()).json()).user,user);
  });
  await t.test('edits synchronize business names and protect against stale overwrite and invalid input',async()=>{
    await db.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3)',['00000000-0000-4000-8000-000000000001',first.id,'Old']);
    assert.equal((await call('/profile',{name:'组织昵称',signature:'新版签名',version:1})).status,200);
    assert.equal((await db.query<{name:string}>('SELECT name FROM mas_business_user')).rows[0].name,'组织昵称');
    assert.equal((await call('/profile',{name:'过期编辑',signature:'',version:1})).status,409);
    for(const body of [{name:' '},{signature:'x'.repeat(201)},{name:'x'.repeat(121)},{id:second.id},{image:'https://evil.test/avatar'},{avatar:Buffer.from('<svg/>').toString('base64')}]){
      assert.equal((await call('/profile',{name:'不得保存',signature:'',version:2,...body})).status,400);
    }
    assert.equal((await call('/profile',{name:'不得保存',signature:'',version:2,avatar:Buffer.alloc(10*1024*1024+1).toString('base64')})).status,413);
    const profile=await readPersonalProfile(pool,first.id);assert.equal(profile?.version,2);assert.equal(profile?.name,'组织昵称');assert.equal(profile?.signature,'新版签名');
    imagePath=profile!.image!;assert.equal((await call(imagePath.replace('/api/account',''))).status,200);
  });
  await t.test('no session, cross-origin, other-user and suspended access are denied',async()=>{
    cookie='';assert.equal((await call()).status,401);
    cookie=secondCookie;assert.equal((await call(imagePath.replace('/api/account',''))).status,404);
    assert.equal((await (await call()).json()).user.name,'其他用户');
    cookie=firstCookie;assert.equal((await call('/profile',{name:'CSRF',signature:'',version:2},'https://evil.test')).status,403);
    await db.query("UPDATE mas_business_user SET status='suspended' WHERE identity_id=$1",[first.id]);
    assert.equal((await call()).status,403);assert.equal((await call(imagePath.replace('/api/account',''))).status,403);
    assert.equal((await call('/profile',{name:'拒绝',signature:'',version:2})).status,403);
    await db.query("UPDATE mas_business_user SET status='active' WHERE identity_id=$1",[first.id]);
  });
  await t.test('real HTTP intake accepts a 9 MiB avatar only on the profile endpoint',async()=>{
    const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
    const address=server.address();assert.ok(address&&typeof address!=='string');const local='http://127.0.0.1:'+address.port;
    const localApp=createAccountService({pool,identity:{...identity,principal:async()=>first},origin:local});
    server.on('request',createAccountWebHandler(localApp,local,'dist-account'));
    const large=await sharp(randomBytes(1800*1800*3),{raw:{width:1800,height:1800,channels:3}}).png({compressionLevel:0}).toBuffer();assert.ok(large.length>9*1024*1024);
    const body=JSON.stringify({name:'大图头像',signature:'',version:2,avatar:large.toString('base64')});
    const response=await fetch(local+'/api/account/profile',{method:'POST',headers:{origin:local,'Content-Type':'application/json'},body});assert.equal(response.status,200);
    assert.ok(response.headers.get('content-security-policy')?.includes('https://avatars.githubusercontent.com'));
    const oversized='x'.repeat(110000);
    assert.equal((await fetch(local+'/api/account/profile/other',{method:'POST',body:oversized})).status,413);
    assert.equal((await fetch(local+'/api/identity/sign-in/email',{method:'POST',body:oversized})).status,413);
  });
});
