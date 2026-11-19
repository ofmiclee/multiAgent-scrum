import {manageDeviceCodex} from './device-codex.ts';
import {resolveDeviceLaunch} from './device-config.ts';
import {defaultDeviceRoot} from './device-identity.ts';

const stop=new AbortController(),abort=()=>stop.abort();
process.once('SIGINT',abort);process.once('SIGTERM',abort);
try{
  if(process.env.NODE_ENV==='production')throw Error('Production Runner authorization is not configured');
  if(process.argv.length!==3)throw Error('Choose exactly one Codex account action');
  const root=process.env.MAS_RUNNER_HOME??defaultDeviceRoot(),launch=await resolveDeviceLaunch(root,process.env);
  if(!launch.codex)throw Error('Codex command is not configured; use runner:setup');
  const view=await manageDeviceCodex({root,server:launch.server,config:launch.codex,action:process.argv[2],signal:stop.signal,onLoginUrl:url=>console.log(JSON.stringify({type:'codex-login',url}))});
  console.log(JSON.stringify(view));
}catch{
  console.error('Codex account action blocked. Run npm run runner:doctor for read-only local checks. Use status|detect|use-local|login|disconnect; stop this Runner first and inspect its journal, server pin and explicit Codex paths. Native credentials were not reset.');
  process.exitCode=1;
}finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
