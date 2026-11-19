import assert from 'node:assert/strict';
import test from 'node:test';
import {CredentialExecutor} from '../services/runner/credential-executor.ts';

test('Agent attempts use their pinned local credential and never fall back',async()=>{
  const calls:string[]=[];
  const make=(name:string)=>({run:async()=>{calls.push(name);return {summary:name,artifacts:[],checksPassed:false};}});
  const router=new CredentialExecutor(new Map([['legacy',make('subscription')],['b4ccbd1c-5ef5-40a3-8fa7-6fc5543ea79a',make('api-key')]]));
  const input={taskId:'t',attemptId:'a',fence:1,title:'Task',description:'',acceptance:'',feedback:[],cwd:''};
  const signal=new AbortController().signal;
  assert.equal((await router.run({...input,credentialId:'b4ccbd1c-5ef5-40a3-8fa7-6fc5543ea79a'},signal)).summary,'api-key');
  assert.equal((await router.run({...input,credentialId:'legacy'},signal)).summary,'subscription');
  assert.throws(()=>router.run({...input,credentialId:'missing'},signal),/unavailable/);
  assert.deepEqual(calls,['api-key','subscription']);
});
