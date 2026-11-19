import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createAccountWebHandler} from '../services/account/web.ts';

test('account site serves the Runner DMG and separate local credential helper',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mas-runner-download-'));
  const site=join(root,'site'),downloads=join(root,'downloads');
  await mkdir(site);await mkdir(downloads);
  const filename='MultiAgent-Scrum-Runner-0.3.10-macos-arm64.dmg';
  await writeFile(join(downloads,filename),'test-dmg');
  await writeFile(join(downloads,'runner-release.json'),JSON.stringify({filename}));
  await writeFile(join(downloads,'MultiAgent-Scrum-Runner-macos.zip'),'old-zip');
  await mkdir(join(site,'downloads'));
  await writeFile(join(site,'downloads','Configure-Agent-API-Key.zip'),'test-helper');
  await writeFile(join(site,'shadcn-radix-notices.txt'),'MIT license notices');
  await writeFile(join(site,'private.txt'),'not public');
  const server=createServer();
  try{
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();
    assert.ok(address&&typeof address!=='string');
    const origin='http://127.0.0.1:'+address.port;
    server.on('request',createAccountWebHandler({handle:async()=>new Response('not found',{status:404})},origin,site,downloads));
    const dmg=await fetch(origin+'/downloads/MultiAgent-Scrum-Runner-macos-arm64.dmg',{method:'HEAD'});
    assert.equal(dmg.status,200);
    assert.equal(dmg.headers.get('content-type'),'application/x-apple-diskimage');
    assert.equal(dmg.headers.get('content-disposition'),`attachment; filename="${filename}"`);
    assert.equal((await fetch(origin+'/downloads/MultiAgent-Scrum-Runner-macos.zip')).status,404);
    assert.equal(await (await fetch(origin+'/downloads/MultiAgent-Scrum-Runner-macos-arm64.dmg')).text(),'test-dmg');
    await writeFile(join(downloads,'runner-release.json'),JSON.stringify({filename:'../outside.dmg'}));
    assert.equal((await fetch(origin+'/downloads/MultiAgent-Scrum-Runner-macos-arm64.dmg')).status,404);
    const helper=await fetch(origin+'/downloads/Configure-Agent-API-Key.zip');
    assert.equal(helper.status,200);
    assert.equal(helper.headers.get('content-type'),'application/zip');
    assert.equal(await helper.text(),'test-helper');
    const notices=await fetch(origin+'/shadcn-radix-notices.txt');
    assert.equal(notices.status,200);
    assert.equal(notices.headers.get('content-type'),'text/plain; charset=utf-8');
    assert.equal(await notices.text(),'MIT license notices');
    assert.equal((await fetch(origin+'/private.txt')).status,404);
  }finally{
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
