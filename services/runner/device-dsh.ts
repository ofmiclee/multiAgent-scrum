import {join} from 'node:path';
import {z} from 'zod';
import {DshConnection,type DshConnectionOptions} from './dsh-connection.ts';
import {loadDeviceIdentity,acquireDeviceLock} from './device-identity.ts';
import {TaskJournal} from './task-journal.ts';
import {DeviceWorkBlocked,localDeviceServer} from './device-client.ts';

/** Local device consent, not a Web user login. The journal pins its server and
 * the registry separately authenticates the device's current project member.
 * The same device lock protects account commands and the long-running worker.
 */
export async function manageDeviceDsh(options:{root:string;server:string;config:DshConnectionOptions;action:string;signal?:AbortSignal},backend?:ConstructorParameters<typeof DshConnection>[3]) {
  options.signal?.throwIfAborted();
  const action=z.enum(['status','detect','use-local','disconnect']).parse(options.action);
  const server=localDeviceServer(options.server),identity=await loadDeviceIdentity(options.root);
  const release=await acquireDeviceLock(options.root);
  let account:DshConnection|undefined;
  let closing:Promise<void>|undefined;
  const abort=()=>{closing=account?.close();void closing?.catch(()=>{});};
  try {
    const journal=new TaskJournal(options.root,server);await journal.initialize();
    if(action!=='status'&&(await journal.pending()).some(p=>!p.terminal))
      throw new DeviceWorkBlocked('Unfinished task journal requires local process inspection before account changes');
    account=new DshConnection(join(options.root,'dsh-account'),identity.runnerId,options.config,backend);
    options.signal?.addEventListener('abort',abort,{once:true});
    options.signal?.throwIfAborted();
    await account.initialize();
    options.signal?.throwIfAborted();
    if(action==='detect')await account.detect();
    else if(action==='use-local')await account.connectLocal();
    else if(action==='disconnect')await account.disconnect(async()=>{});
    // connectLocal owns its atomic consent commit boundary. A cancellation
    // after successful publication must not be reported as an uncommitted grant.
    if(action!=='use-local')options.signal?.throwIfAborted();
    return {runnerId:identity.runnerId,account:account.view()};
  } finally {options.signal?.removeEventListener('abort',abort);try{await closing;await account?.close();}finally{await release();}}
}
