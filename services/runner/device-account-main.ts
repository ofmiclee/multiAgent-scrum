import {manageDeviceDsh} from './device-dsh.ts';
import {resolveDeviceLaunch} from './device-config.ts';
import {defaultDeviceRoot} from './device-identity.ts';

try {
  if(process.env.NODE_ENV==='production')throw Error('Production Runner authorization is not configured');
  if(process.argv.length!==3)throw Error('Choose exactly one account action');
  const root=process.env.MAS_RUNNER_HOME??defaultDeviceRoot(),launch=await resolveDeviceLaunch(root,process.env);
  if(!launch.dsh)throw Error('DSH paths not configured; use runner:setup');
  const view=await manageDeviceDsh({root,server:launch.server,config:launch.dsh,action:process.argv[2]});
  console.log(JSON.stringify(view));
} catch {
  console.error('DSH account action blocked. Run npm run runner:doctor for read-only local checks. Use status|detect|use-local|disconnect; stop this Runner first and inspect its journal, server pin and explicit DSH paths. Native credentials were not reset.');
  process.exitCode=1;
}
