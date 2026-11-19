import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseLocalDirectory} from '../services/runner/directory-picker.ts';

test('Runner asks the macOS folder picker and returns a usable absolute directory',async()=>{
  const calls:{file:string;args:string[]}[]=[];
  const result=await chooseLocalDirectory(AbortSignal.timeout(1000),async(file,args)=>{
    calls.push({file,args});return {stdout:'/Users/member/work/project/\n'};
  },'darwin');
  assert.deepEqual(result,{result:'selected',directory:'/Users/member/work/project'});
  assert.equal(calls[0].file,'/usr/bin/osascript');
  assert.equal(calls[0].args[0],'-e');
  assert.match(calls[0].args[1],/choose folder/);
});

test('cancelling the native folder picker does not create a directory choice',async()=>{
  const result=await chooseLocalDirectory(AbortSignal.timeout(1000),async()=>{
    throw Object.assign(new Error('cancelled'),{stderr:'User canceled. (-128)'});
  },'darwin');
  assert.deepEqual(result,{result:'cancelled'});
});
