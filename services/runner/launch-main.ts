import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {attachRunnerLaunch} from './launch-link.ts';
import {defaultDeviceRoot} from './device-identity.ts';
import {localDeviceServer} from './device-client.ts';
import {runRetainedConnectionWorker} from './launch-worker.ts';
import {runNativeSetupJson} from './native-setup.ts';
import {watchRunnerParent} from './parent-liveness.ts';

async function main(){
  // Build-owned, credential-free metadata beside the compiled entrypoint.
  const config=JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)),'launch-config.json'),'utf8')) as {origin?:unknown};
  if(typeof config.origin!=='string'||localDeviceServer(config.origin)!==config.origin)throw Error('Invalid package configuration');
  if(process.argv.length!==3)throw Error('Invalid mode');
  const root=defaultDeviceRoot();
  if(process.argv[2]==='capabilities'){
    process.stdout.write(JSON.stringify({apiKeyCatalog:1}));
    return;
  }
  if(process.argv[2]==='codex-key'||process.argv[2]==='dsh-key'){
    const provider=process.argv[2];
    let key='';
    for await(const chunk of process.stdin){key+=chunk.toString();if(Buffer.byteLength(key)>2048)throw Error('Invalid API key input');}
    const result=await runNativeSetupJson(JSON.stringify({op:provider,apiKey:key.trim(),label:process.env.MAS_KEY_LABEL??(provider==='codex-key'?'Codex API Key':'DSH API Key')}),{root,allowedOrigin:config.origin,bundledCodexCommand:join(dirname(fileURLToPath(import.meta.url)),'codex-runtime/bin/codex'),bundledDshRuntime:join(dirname(fileURLToPath(import.meta.url)),'dsh-runtime/node_modules/@deepseek-ai/dsh')});
    process.stdout.write(result);
    return;
  }
  if(process.argv[2]==='attach'||process.argv[2]==='setup'){
    const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
    const limit=process.argv[2]==='attach'?2048:8192;
    let value='';for await(const chunk of process.stdin){value+=chunk.toString();if(Buffer.byteLength(value)>limit)throw Error('Invalid helper input');}
    if(process.argv[2]==='attach')process.stdout.write(JSON.stringify(await attachRunnerLaunch(value,config.origin,root)));
    else process.stdout.write(await runNativeSetupJson(value,{root,allowedOrigin:config.origin,signal:stop.signal,bundledDshRuntime:join(dirname(fileURLToPath(import.meta.url)),'dsh-runtime/node_modules/@deepseek-ai/dsh'),bundledCodexCommand:join(dirname(fileURLToPath(import.meta.url)),'codex-runtime/bin/codex'),
      onLoginUrl:url=>process.stdout.write(JSON.stringify({event:'login-url',url})+'\n')}));
    return;
  }
  if(process.argv[2]!=='run')throw Error('Invalid mode');
  const stop=new AbortController();process.once('SIGTERM',()=>stop.abort());process.once('SIGINT',()=>stop.abort());
  const unwatch=watchRunnerParent(stop);
  try{await runRetainedConnectionWorker({allowedOrigin:config.origin,root,signal:stop.signal});}
  finally{unwatch();}
}
main().catch(()=>{process.stderr.write('Runner 未能连接。请检查本机配置、服务地址或已有 Runner 进程，然后返回网页重试。身份与凭据未重置。\n');process.exitCode=1;});
