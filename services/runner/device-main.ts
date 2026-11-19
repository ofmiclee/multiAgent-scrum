import {resolveDeviceLaunch} from './device-config.ts';
import {TaskJournal} from './task-journal.ts';
import {openDeviceExecution} from './device-execution.ts';
import {loadDeviceIdentity,defaultDeviceRoot,acquireDeviceLock} from './device-identity.ts';
import {runDeviceClient} from './device-client.ts';
import {ProjectSetupWorker} from './project-setup-worker.ts';

const stop=new AbortController();
process.once('SIGINT',()=>stop.abort());
process.once('SIGTERM',()=>stop.abort());
let release:(()=>Promise<void>)|undefined;
let execution:Awaited<ReturnType<typeof openDeviceExecution>>|undefined;
try {
  const root=process.env.MAS_RUNNER_HOME??defaultDeviceRoot();
  const identity=await loadDeviceIdentity(root);
  release=await acquireDeviceLock(root);
  const launch=await resolveDeviceLaunch(root,process.env),server=launch.server;
  if(process.env.NODE_ENV==='production'&&server!=='https://scrum.fruitbuddy.cn')throw Error('Production Runner requires the approved HTTPS server');
  const journal=new TaskJournal(root,server);
  await journal.initialize();
  execution=await openDeviceExecution({root,identity,launch,journal});
  if(execution.tasks){
    const mode=!execution.accepting()
      ?{type:'task-recovery-only',message:'Local native account is not accepting work. Only durable terminal receipts may be replayed; no new model calls.'}
      :launch.profile==='demo'
        ?{type:'demo-task-mode',message:'Simulated writing only; enable and grant this Agent in Web. No model calls.'}
        :{type:launch.profiles?'native-task-mode':launch.profile==='codex-code'?'codex-code-task-mode':'dsh-text-task-mode',
          message:'Authorized local native tasks only; enabled and granted tasks may use account quota.'};
    console.log(JSON.stringify({...mode,runnerId:identity.runnerId}));
  }
  await runDeviceClient({server,identity,name:launch.name,signal:stop.signal,event:event=>console.log(JSON.stringify(event)),tasks:execution.tasks,setup:new ProjectSetupWorker({server,identity})});
} catch {
  console.error('Runner connection stopped. Run npm run runner:doctor for read-only local checks. Check server, binding, journal and identity lock; native modes also require explicit runner:dsh or runner:codex consent. No credentials were reset.');process.exitCode=1;
} finally {
  try {await execution?.close();}catch{process.exitCode=1;}
  try {await release?.();}catch{console.error('Runner identity lock needs local inspection.');process.exitCode=1;}
}
