import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import {test} from 'node:test';

// Browser tests verify persisted outcomes. This inventory guard prevents the
// generic second-step panels from silently returning on an unvisited Web page.
test('formal Web has no generic second-step operation confirmation labels',async()=>{
  const directory=new URL('./',import.meta.url);
  for(const file of (await readdir(directory)).filter(file=>file.endsWith('.tsx'))){
    const source=await readFile(new URL(file,directory),'utf8');
    assert.doesNotMatch(source,/确认操作|取消操作|确认执行设置|取消确认|确认撤销|取消撤销|确认下载|取消下载|核对绑定信息|确认绑定到我的账号/,file);
  }
});
