import {createInterface} from 'node:readline/promises';
import {defaultDeviceRoot} from './device-identity.ts';
import {setupDevice} from './device-setup.ts';

try{
  if(process.env.NODE_ENV==='production')throw Error('Production authorization not configured');
  if(process.argv.length!==2||!process.stdin.isTTY||!process.stdout.isTTY)throw Error('Interactive terminal required');
  const terminal=createInterface({input:process.stdin,output:process.stdout}),stop=new AbortController();
  const abort=()=>stop.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);terminal.once('SIGINT',abort);terminal.once('close',abort);
  try{
    await setupDevice({root:process.env.MAS_RUNNER_HOME??defaultDeviceRoot(),signal:stop.signal,ask:prompt=>terminal.question(prompt,{signal:stop.signal}),tell:message=>console.log(message)});
  }finally{terminal.close();process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}catch{
  console.error('Runner setup stopped. Use an interactive terminal. Run npm run runner:doctor for read-only local checks. Check local configuration, identity lock, journal and explicit DSH paths; no native credentials were reset.');process.exitCode=1;
}
