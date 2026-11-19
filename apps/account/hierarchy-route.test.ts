import test from 'node:test';
import assert from 'node:assert/strict';
import {hierarchyHash,readHierarchyRoute,projectManagementPage,type ProjectPage} from './hierarchy-route.ts';
import {takeLifecycleLink} from './lifecycle-link.ts';

test('hierarchy routes round-trip only navigation identifiers and remain separate from account callback hashes',()=>{
  for(const page of ['home','create-project'] as const){
    const route={organizationId:null,page};
    assert.deepEqual(readHierarchyRoute(hierarchyHash(route)),route);
  }
  assert.deepEqual(readHierarchyRoute('#/organizations'),{organizationId:null});
  const organizationId='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',boardId='33333333-3333-4333-8333-333333333333',taskId='44444444-4444-4444-8444-444444444444';
  for(const page of ['board','stories','create-story','execution','automatic','grants','agents','members','settings'] as ProjectPage[]){
    const route={organizationId,section:projectManagementPage(page)?'projects' as const:'boards' as const,project:{id,boardId,page,...(page==='execution'?{taskId}:{})}};
    const hash=hierarchyHash(route);assert.deepEqual(readHierarchyRoute(hash),route);
    assert.equal(takeLifecycleLink({hash,pathname:'/',search:''},{replaceState:()=>assert.fail('Hierarchy URL must survive startup')}),null);
  }
  for(const hash of ['#devices','#agents','#runner-return=untrusted','#verify-email=token','#reset-password=token',''])assert.equal(readHierarchyRoute(hash),null);
  for(const hash of ['#/organizations/name/boards','#/organizations/'+organizationId+'/projects/'+id+'/boards/'+boardId+'/settings/tasks/'+taskId,'#/organizations/'+organizationId+'/boards?secret=x'])assert.equal(readHierarchyRoute(hash),'invalid');
  let scrubbed=false;assert.deepEqual(takeLifecycleLink({hash:'#reset-password=token',pathname:'/',search:''},{replaceState:()=>{scrubbed=true;}}),{kind:'reset-password',token:'token'});assert.equal(scrubbed,true);
});
