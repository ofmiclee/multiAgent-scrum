import {constants} from 'node:fs';
import {lstat,mkdir,open,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {codeBindingSchema,type CodeBinding} from '../../packages/domain/code-transfer.ts';
import {SnapshotStore} from './snapshots.ts';
import {acquireDeviceLock,loadDeviceIdentity} from './device-identity.ts';
import {TaskJournal} from './task-journal.ts';
import {DeviceWorkBlocked,localDeviceServer} from './device-client.ts';

const directoryName='code-bindings';
function filename(projectId:string){return createHash('sha256').update(projectId).digest('hex')+'.json';}
async function privateDirectory(path:string,create=false){
  if(create)try{await mkdir(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const value=await lstat(path);
  if(!value.isDirectory()||value.isSymbolicLink()||(value.mode&0o077)||value.uid!==process.getuid?.())throw Error('Unsafe code binding directory');
}
async function readBinding(path:string):Promise<CodeBinding>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const value=await file.stat();
    if(!value.isFile()||value.nlink!==1||(value.mode&0o077)||value.uid!==process.getuid?.()||value.size>8192)throw Error('Unsafe code binding metadata');
    return codeBindingSchema.parse(JSON.parse(await file.readFile('utf8')));
  }finally{await file.close();}
}

/** Side-effect-free private metadata read. Local repository paths are never retained. */
export async function readCodeBindings(root:string):Promise<CodeBinding[]>{
  if(!isAbsolute(root))throw Error('Code binding root must be absolute');
  await privateDirectory(root);
  const directory=join(root,directoryName);
  try{await privateDirectory(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  const names=await readdir(directory);
  if(names.length>10||names.some(name=>!name.match(/^[a-f0-9]{64}\.json$/)))throw Error('Unknown code binding metadata');
  const bindings=[];
  for(const name of names.sort()){
    const binding=await readBinding(join(directory,name));
    if(filename(binding.projectId)!==name)throw Error('Code binding identity mismatch');
    bindings.push(binding);
  }
  if(new Set(bindings.map(binding=>binding.projectId)).size!==bindings.length)throw Error('Duplicate code binding metadata');
  return bindings;
}

export async function bindCodeRepository(options:{root:string;server:string;projectId:string;repository:string;ref:string}):Promise<CodeBinding>{
  const projectId=codeBindingSchema.shape.projectId.parse(options.projectId),server=localDeviceServer(options.server);
  await loadDeviceIdentity(options.root);
  const release=await acquireDeviceLock(options.root);
  try{
    const journal=new TaskJournal(options.root,server);await journal.initialize();
    if((await journal.pending()).some(item=>!item.terminal))throw new DeviceWorkBlocked('Unfinished task journal requires local process inspection before repository binding');
    const bindings=await readCodeBindings(options.root);
    if(bindings.some(binding=>binding.projectId===projectId))throw Error('Code repository binding is already immutable for this project');
    if(bindings.length>=10)throw Error('Code repository binding limit is 10 projects');
    const repository=await new SnapshotStore(join(options.root,'code-snapshots')).importGit(options.repository,options.ref,new AbortController().signal);
    const binding=codeBindingSchema.parse({projectId,repository});
    const directory=join(options.root,directoryName);await privateDirectory(directory,true);
    const file=await open(join(directory,filename(projectId)),'wx',0o600);
    try{await file.writeFile(JSON.stringify(binding));await file.sync();}finally{await file.close();}
    const handle=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}
    return binding;
  }finally{await release();}
}
