import assert from 'node:assert/strict';
import test from 'node:test';
import {macRunnerDownload,runnerDownloadFor} from './RunnerDownload.tsx';

test('Runner download follows the visiting operating system without offering incompatible packages',()=>{
  assert.equal(runnerDownloadFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)').href,macRunnerDownload);
  assert.equal(runnerDownloadFor('Mozilla/5.0 (Windows NT 10.0; Win64; x64)').href,null);
  assert.equal(runnerDownloadFor('Mozilla/5.0 (X11; Linux x86_64)').href,null);
  assert.equal(runnerDownloadFor('Mozilla/5.0 (Linux; Android 14)').href,null);
  assert.equal(runnerDownloadFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0)',5).href,null);
});
