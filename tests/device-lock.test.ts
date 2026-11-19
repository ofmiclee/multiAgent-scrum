import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
import {acquireDeviceLock,deviceLockActive} from '../services/runner/device-identity.ts';
import {diagnoseDevice} from '../services/runner/device-doctor.ts';

async function privateRoot(){return mkdtemp(join(tmpdir(),'mas-device-lock-'));}

test('an abandoned legacy PID file does not prevent the next Runner from starting',async()=>{
  const root=await privateRoot();
  try{
    await writeFile(join(root,'device.lock'),JSON.stringify({pid:99_999_999}),{mode:0o600});
    const release=await acquireDeviceLock(root);
    await release();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a live legacy Runner still blocks an upgraded Runner',async()=>{
  const root=await privateRoot();
  try{
    await writeFile(join(root,'device.lock'),JSON.stringify({pid:process.pid}),{mode:0o600});
    await assert.rejects(acquireDeviceLock(root),/already active|inspection/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('only one Runner can hold the local lock and release permits immediate reacquisition',async()=>{
  const root=await privateRoot();
  try{
    const release=await acquireDeviceLock(root);
    await assert.rejects(acquireDeviceLock(root),/already active|occupied/i);
    await release();
    const next=await acquireDeviceLock(root);
    await next();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnostics do not mistake a released lock marker for a running Runner',async()=>{
  const root=await privateRoot();
  try{
    const release=await acquireDeviceLock(root);
    const active=await diagnoseDevice(root);
    assert.ok(active.checks.some(check=>check.code==='DEVICE_LOCK_PRESENT'));
    await release();
    const stopped=await diagnoseDevice(root);
    assert.ok(!stopped.checks.some(check=>check.code==='DEVICE_LOCK_PRESENT'));
    assert.ok(!stopped.checks.some(check=>check.code==='JOURNAL_NOT_INSPECTED'));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('read-only lock inspection never creates a missing identity directory',async()=>{
  const parent=await privateRoot(),root=join(parent,'missing');
  try{
    await assert.rejects(deviceLockActive(root));
    await assert.rejects(stat(root),{code:'ENOENT'});
  }finally{await rm(parent,{recursive:true,force:true});}
});

test('SIGKILL releases the Runner lock without manually deleting a file',async()=>{
  const root=await privateRoot();
  const module=resolve('services/runner/device-identity.ts');
  const code=`import {acquireDeviceLock} from ${JSON.stringify(module)}; await acquireDeviceLock(process.argv[1]); process.stdout.write('READY\\n'); setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--import','tsx','-e',code,root],{cwd:resolve('.'),stdio:['ignore','pipe','pipe']});
  let timer:NodeJS.Timeout|undefined;
  try{
    await Promise.race([
      new Promise<void>((done,fail)=>{
        let output='';
        child.stdout!.on('data',chunk=>{output+=chunk;if(output.includes('READY'))done();});
        child.once('exit',code=>fail(Error(`Runner exited before locking (${code})`)));
      }),
      new Promise<never>((_,fail)=>{timer=setTimeout(()=>fail(Error('Runner did not acquire lock')),5000);}),
    ]);
    await assert.rejects(acquireDeviceLock(root),/already active|occupied/i);
    child.kill('SIGKILL');
    await once(child,'exit');
    const release=await acquireDeviceLock(root);
    await release();
  }finally{
    if(timer)clearTimeout(timer);
    if(child.exitCode===null)child.kill('SIGKILL');
    await rm(root,{recursive:true,force:true});
  }
});
