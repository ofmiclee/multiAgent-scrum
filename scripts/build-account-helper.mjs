import {cp,chmod,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const exec=promisify(execFile);
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const output=join(root,'apps/account/public/downloads/Configure-Agent-API-Key.zip');
const work=await mkdtemp(join(tmpdir(),'mas-agent-key-helper-'));
try{
  const name='Configure-Agent-API-Key.command',file=join(work,name);
  await cp(join(root,'scripts/helpers',name),file);await chmod(file,0o755);
  await mkdir(join(root,'apps/account/public/downloads'),{recursive:true});
  await rm(output,{force:true});
  await exec('/usr/bin/zip',['-X','-q',output,name],{cwd:work});
}finally{await rm(work,{recursive:true,force:true});}
