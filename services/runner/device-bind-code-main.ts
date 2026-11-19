import {bindCodeRepository} from './code-bindings.ts';
import {resolveDeviceLaunch} from './device-config.ts';
import {defaultDeviceRoot} from './device-identity.ts';

try{
  if(process.env.NODE_ENV==='production')throw Error('Production Runner authorization is not configured');
  if(process.argv.length!==5)throw Error('Provide project id, absolute repository path and committed ref');
  const root=process.env.MAS_RUNNER_HOME??defaultDeviceRoot(),launch=await resolveDeviceLaunch(root,process.env);
  const binding=await bindCodeRepository({root,server:launch.server,projectId:process.argv[2]!,repository:process.argv[3]!,ref:process.argv[4]!});
  console.log(JSON.stringify(binding));
}catch{
  console.error('Code repository binding blocked. Stop this Runner, inspect its journal and use one formal project UUID, an absolute local Git root and an explicit committed ref. No repository files were changed.');
  process.exitCode=1;
}
