import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, link, realpath, rename, unlink } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, isAbsolute } from 'node:path';
import { z } from 'zod';

const identitySchema = z.object({
  version: z.literal(1),
  runnerId: z.string().uuid(),
  credential: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type DeviceIdentity = z.infer<typeof identitySchema>;

export function defaultDeviceRoot() {
  if (process.platform === 'win32') throw Error('Windows device credential ACL support is not yet validated');
  return process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'MultiAgent-Scrum', 'runner')
    : join(homedir(), '.local', 'share', 'MultiAgent-Scrum', 'runner');
}

async function privateDirectory(root: string) {
  if (process.platform === 'win32') throw Error('Windows device credential ACL support is not yet validated');
  if (!isAbsolute(root)) throw Error('Runner identity directory must be absolute');
  await mkdir(root, {recursive:true, mode:0o700});
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid!())
    throw Error('Runner identity requires a private owned directory');
}

async function readIdentity(file: string): Promise<DeviceIdentity> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.uid !== process.getuid!() || info.size > 4096)
      throw Error('Unsafe Runner identity permissions');
    const parsed = identitySchema.safeParse(JSON.parse(await handle.readFile('utf8')));
    if (!parsed.success) throw Error('Invalid Runner identity; explicit recovery is required');
    return parsed.data;
  } catch {
    throw Error('Cannot read Runner identity; do not reset it automatically');
  } finally { await handle.close(); }
}

/** Local diagnosis must not manufacture an identity or return its credential. */
export async function inspectDeviceIdentity(root:string):Promise<{runnerId:string}|undefined>{
  if(!isAbsolute(root)||process.platform==='win32')throw Error('Unsupported identity inspection');
  const dir=await lstat(root);
  if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)||dir.uid!==process.getuid?.())throw Error('Unsafe identity directory');
  const file=join(root,'identity.json');
  try{await lstat(file);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  return {runnerId:(await readIdentity(file)).runnerId};
}

/** Program upgrades/removal never touch this separate persistent identity root. */
export async function loadDeviceIdentity(root: string): Promise<DeviceIdentity> {
  await privateDirectory(root);
  const file = join(root, 'identity.json');
  try { await waitForPublication(file); return await readIdentity(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const value: DeviceIdentity = {version:1, runnerId:randomUUID(), credential:randomBytes(32).toString('hex')};
  const temp = join(root, `.identity-${randomUUID()}`);
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    // Atomic no-replace publication: a competing first start can never overwrite identity.
    await link(temp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally { await unlink(temp); }
  await waitForPublication(file);
  return readIdentity(file);
}

// Both initial readers and competing publishers observe the same bounded window.
async function waitForPublication(file:string) {
  for (let n = 0; n < 20; n++) {
    if ((await lstat(file)).nlink === 1) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Runner identity publication incomplete; manual inspection required');
}

const deviceLockMarker = z.union([
  z.object({pid:z.number().int().positive()}).strict(),
  z.object({version:z.literal(2),pid:z.number().int().positive()}).strict(),
]);

async function publishLockMarker(file:string,replace=false){
  const temp=join(dirname(file),`.device-lock-${randomUUID()}`);
  const handle=await open(temp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify({version:2,pid:process.pid}));await handle.sync();}
  finally{await handle.close();}
  try{
    if(replace)await rename(temp,file);
    else await link(temp,file);
  }finally{await unlink(temp).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}

async function inspectLockMarker(file:string){
  let handle;
  try{handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'absent' as const;throw Error('Runner identity lock needs inspection');}
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.nlink!==1||(info.mode&0o077)||info.uid!==process.getuid?.()||info.size>256)
      throw Error('Runner identity lock needs inspection');
    const marker=deviceLockMarker.parse(JSON.parse(await handle.readFile('utf8')));
    if('version' in marker)return 'current' as const;
    try{process.kill(marker.pid,0);throw Error('Runner already active');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    return 'legacy-stale' as const;
  }catch(error){if(error instanceof Error&&error.message==='Runner already active')throw error;throw Error('Runner identity lock needs inspection');}
  finally{await handle.close();}
}

async function lockPort(root:string){
  const canonical=await realpath(root);
  const hash=createHash('sha256').update('mas-runner-lock:'+canonical).digest();
  return 20_000+hash.readUInt32BE(0)%29_152;
}

/** Diagnostic snapshot: an old PID marker is relevant only while that PID lives. */
export async function deviceLockActive(root:string):Promise<boolean>{
  if(!isAbsolute(root)||process.platform==='win32')throw Error('Unsupported Runner lock inspection');
  const directory=await lstat(root);
  if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077)||directory.uid!==process.getuid?.())
    throw Error('Unsafe Runner identity directory');
  try{await inspectLockMarker(join(root,'device.lock'));}
  catch(error){if(error instanceof Error&&error.message==='Runner already active')return true;throw error;}
  const port=await lockPort(root);
  return new Promise<boolean>((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port});
    socket.setTimeout(1000,()=>socket.destroy(Error('Runner local lock probe timed out')));
    socket.once('connect',()=>{socket.destroy();resolve(true);});
    socket.once('error',error=>{
      socket.destroy();
      if((error as NodeJS.ErrnoException).code==='ECONNREFUSED')resolve(false);
      else reject(error);
    });
  });
}

/** The loopback listener is held by this process, so a crash releases the
 * exclusive claim without trusting a persistent file or a network lease. */
export async function acquireDeviceLock(root: string): Promise<() => Promise<void>> {
  await privateDirectory(root);
  const file=join(root,'device.lock');
  let marker=await inspectLockMarker(file);
  if(marker==='absent'){
    try{await publishLockMarker(file);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      marker=await inspectLockMarker(file);
    }
  }
  const port=await lockPort(root);
  const server=createServer(socket=>socket.destroy());
  try{
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject);
      server.listen({host:'127.0.0.1',port,exclusive:true},()=>{server.removeListener('error',reject);resolve();});
    });
  }catch(error){
    throw Error((error as NodeJS.ErrnoException).code==='EADDRINUSE'?'Runner already active or local lock port occupied':'Runner local lock unavailable');
  }
  server.unref();
  try{if(marker==='legacy-stale')await publishLockMarker(file,true);}
  catch(error){await new Promise<void>(resolve=>server.close(()=>resolve()));throw error;}
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  };
}
