import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {watchRunnerParent} from '../services/runner/parent-liveness.ts';

test('packaged Runner aborts its heartbeat worker when the app parent disappears',async()=>{
  let observedParent=1234;
  const stop=new AbortController();
  const unwatch=watchRunnerParent(stop,{parentPid:1234,readParentPid:()=>observedParent,intervalMs:5});
  try{
    await delay(20);
    assert.equal(stop.signal.aborted,false);
    observedParent=1;
    await delay(20);
    assert.equal(stop.signal.aborted,true);
  }finally{unwatch();}
});

test('a worker already orphaned before startup does not connect',()=>{
  const stop=new AbortController();
  watchRunnerParent(stop,{parentPid:1});
  assert.equal(stop.signal.aborted,true);
});

test('the OS reparents a surviving child so the worker can detect a killed app',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mas-parent-watch-'));
  const child=join(root,'child.mjs'),parent=join(root,'parent.mjs'),ready=join(root,'ready'),stopped=join(root,'stopped');
  await writeFile(child,`import {writeFile} from 'node:fs/promises';
const owner=process.ppid;
await writeFile(${JSON.stringify(ready)},String(owner));
const timer=setInterval(async()=>{if(process.ppid===owner)return;clearInterval(timer);await writeFile(${JSON.stringify(stopped)},String(process.ppid));},10);
setTimeout(()=>clearInterval(timer),3000);`);
  await writeFile(parent,`import {spawn} from 'node:child_process';import {readFile,writeFile} from 'node:fs/promises';
const child=spawn(process.execPath,[${JSON.stringify(child)}],{detached:true,stdio:'ignore'});child.unref();
await writeFile(${JSON.stringify(join(root,'pid'))},String(child.pid));
while(!(await readFile(${JSON.stringify(ready)}).catch(()=>null)))await new Promise(resolve=>setTimeout(resolve,10));`);
  let pid:number|undefined;
  try{
    await new Promise<void>((resolve,reject)=>{const parentProcess=spawn(process.execPath,[parent],{stdio:'ignore'});parentProcess.once('error',reject);parentProcess.once('exit',code=>code===0?resolve():reject(Error('Parent process failed')));});
    pid=Number(await readFile(join(root,'pid'),'utf8'));
    for(let attempt=0;attempt<100;attempt++){
      const value=await readFile(stopped,'utf8').catch(()=>null);
      if(value!==null){assert.equal(Number(value),1);return;}
      await delay(20);
    }
    assert.fail('Orphaned child did not detect parent exit');
  }finally{if(pid)try{process.kill(pid,'SIGTERM');}catch{}await rm(root,{recursive:true,force:true});}
});
