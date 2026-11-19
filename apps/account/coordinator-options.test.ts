import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinatorCandidates} from './coordinator-options.ts';

test('coordinator selection includes authorized enabled Codex and DSH, not merely online devices',()=>{
  const eligible={enabled:true,revoked:false,projectGrants:[{projectId:'p',enabled:true}]};
  const agents=[{...eligible,id:'codex',profile:'codex-code'},{...eligible,id:'dsh',profile:'dsh-text'},
    {...eligible,id:'demo',profile:'demo'},{...eligible,id:'disabled',profile:'codex-code',enabled:false},
    {...eligible,id:'revoked',profile:'dsh-text',revoked:true},{...eligible,id:'other-project',profile:'codex-code',projectGrants:[{projectId:'q',enabled:true}]},
    {...eligible,id:'ungranted',profile:'codex-code',projectGrants:[{projectId:'p',enabled:false}]}];
  assert.deepEqual(coordinatorCandidates(agents,'p').map(agent=>agent.id),['codex','dsh']);
});
