import {diagnoseDevice} from './device-doctor.ts';
import {defaultDeviceRoot} from './device-identity.ts';

try{
  if(process.argv.length!==2)throw Error('No arguments accepted');
  const report=await diagnoseDevice(process.env.MAS_RUNNER_HOME??defaultDeviceRoot(),process.env);
  console.log(JSON.stringify(report,null,2));process.exitCode=report.status==='attention'?1:0;
}catch{
  console.log(JSON.stringify({version:1,scope:'local-read-only',status:'attention',checks:[{code:'DIAGNOSIS_UNAVAILABLE',level:'attention',message:'诊断无法完成。请不带参数运行 npm run runner:doctor，并核对本机环境；不要清空身份或任务日志。'}]},null,2));
  process.exitCode=1;
}
