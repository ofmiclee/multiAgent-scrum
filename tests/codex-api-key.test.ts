import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {CodexConnection} from '../services/runner/codex-connection.ts';
import {loadDeviceIdentity} from '../services/runner/device-identity.ts';
import {saveDeviceConfig} from '../services/runner/device-config.ts';
import {runNativeSetupOperation} from '../services/runner/native-setup.ts';
import {addCodexSubscription,openCodexCredential} from '../services/runner/credential-catalog.ts';

test('Codex API key connects through a private profile without persisting the key in connection metadata',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mas-codex-key-'));
  const key='sk-test-private-value';
  const calls:string[]=[];
  const auth={
    read:async()=>({type:'chatgpt' as const,email:'person@example.com'}),
    login:async()=>({type:'chatgpt' as const,email:'person@example.com'}),
    loginApiKey:async(options:{codexHome?:string},input:string)=>{assert.equal(input,key);assert.ok(options.codexHome?.startsWith(join(root,'profile-')));calls.push('login');return {type:'apiKey' as const};},
    logout:async(options:{codexHome?:string})=>{assert.ok(options.codexHome?.startsWith(join(root,'profile-')));calls.push('logout');},
  };
  try{
    const connection=new CodexConnection(root,'runner-1',{},auth);
    await connection.initialize();
    assert.equal((await connection.connectApiKey(key)).status,'connected');
    assert.deepEqual(connection.view(),{status:'connected',source:'private',localDetected:null,accountLabel:'API Key'});
    assert.ok(!(await readFile(join(root,'connection.json'),'utf8')).includes(key));
    const reopened=new CodexConnection(root,'runner-1',{},auth);
    await reopened.initialize();
    assert.equal(reopened.view().status,'connected');
    await reopened.disconnect(async()=>{});
    assert.deepEqual(calls,['login','logout']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a legacy private Codex key can coexist with the local subscription',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mas-codex-coexist-'));
  const auth={
    read:async()=>({type:'chatgpt' as const,email:'person@example.com'}),
    login:async()=>({type:'chatgpt' as const,email:'person@example.com'}),
    loginApiKey:async()=>({type:'apiKey' as const}),
    logout:async()=>{},
  };
  try{
    const legacy=new CodexConnection(join(root,'codex-account'),'owner',{command:'/usr/bin/true'},auth);
    await legacy.initialize();await legacy.connectApiKey('sk-legacy');await legacy.close();
    const before=await readFile(join(root,'codex-account','connection.json'),'utf8');
    const metadata=await addCodexSubscription(root,'owner',{command:'/usr/bin/true'},auth);
    assert.equal(metadata.kind,'subscription');
    assert.equal(await readFile(join(root,'codex-account','connection.json'),'utf8'),before);
    const subscription=await openCodexCredential(root,'owner',{command:'/usr/bin/true'},metadata);
    assert.equal(subscription.view().status,'connected');await subscription.close();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('native Codex key setup keeps the key off the response and cloud-facing config',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mas-native-key-'));
  const key='sk-test-native-value';
  const secondKey='sk-test-second-value';
  const server='https://scrum.fruitbuddy.cn';
  try{
    const identity=await loadDeviceIdentity(root);
    await saveDeviceConfig(root,{version:1,server,name:'Test Runner',profile:'codex-code',codex:{command:'/usr/bin/true'}});
    const auth={
      read:async()=>({type:'chatgpt' as const,email:'person@example.com'}),
      login:async()=>({type:'chatgpt' as const,email:'person@example.com'}),
      loginApiKey:async(_options:unknown,input:string)=>{assert.ok([key,secondKey].includes(input));return {type:'apiKey' as const};},
      logout:async()=>{},
    };
    const subscription=new CodexConnection(join(root,'codex-account'),identity.runnerId,{command:'/usr/bin/true'},auth);
    await subscription.initialize();await subscription.connectLocal();await subscription.close();
    const before=await readFile(join(root,'codex-account','connection.json'),'utf8');
    const result=await runNativeSetupOperation({op:'codex-key',apiKey:key},{root,allowedOrigin:server,codexBackend:{
      ...auth,
    }});
    const second=await runNativeSetupOperation({op:'codex-key',label:'另一个 Key',apiKey:secondKey},{root,allowedOrigin:server,codexBackend:auth});
    assert.equal(result.credential.kind,'api-key');
    assert.notEqual(result.credential.id,second.credential.id);
    assert.equal(await readFile(join(root,'codex-account','connection.json'),'utf8'),before);
    assert.ok(!JSON.stringify(result).includes(key));
    assert.ok(!(await readFile(join(root,'runner.json'),'utf8')).includes(key));
    assert.ok(!(await readFile(join(root,'codex-keys',result.credential.id,'connection.json'),'utf8')).includes(key));
    assert.ok(!(await readFile(join(root,'codex-keys',second.credential.id,'connection.json'),'utf8')).includes(secondKey));
    const catalog=await readFile(join(root,'credential-catalog.json'),'utf8');
    assert.ok(!catalog.includes(key));assert.ok(!catalog.includes(secondKey));
    assert.equal(JSON.parse(catalog).credentials.length,2);
  }finally{await rm(root,{recursive:true,force:true});}
});
