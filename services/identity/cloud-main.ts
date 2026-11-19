import {resolve} from 'node:path';
import pg from 'pg';
import {createAccountService} from '../account/service.ts';
import {createAccountWebHandler} from '../account/web.ts';
import {cloudIdentityConfig} from './cloud-config.ts';
import {createCloudRuntime} from './cloud-runtime.ts';
import {createIdentityService} from './service.ts';
import {PostgresArtifactStore} from '../account/postgres-artifact-store.ts';

let startupStage='configuration';
async function main(){
  if(process.argv.length!==2)throw Error('Cloud identity has no command modes');
  const config=cloudIdentityConfig();
  startupStage='database';
  const pool=new pg.Pool(config.database);
  pool.on('error',()=>{process.stderr.write('Cloud identity database connection unavailable\n');});
  let runtime:ReturnType<typeof createCloudRuntime>|undefined;
  let serving=false;
  try{
    const identity=createIdentityService({
      pool,origin:config.origin,secret:config.secret,github:config.github,
      onGithubFailure:stage=>{process.stderr.write(`GitHub login failed at ${stage} stage (credential details omitted)\n`);},
      onGithubDiagnostic:({phase,operation,attempt,status,errorType,code,reason,elapsedMs})=>{
        // Only fixed diagnostic categories and bounded numeric metadata. Omit
        // frames, raw messages, headers, URLs, state, tokens and user profiles.
        process.stderr.write('GitHub diagnostic '+JSON.stringify({phase,operation,attempt,status,errorType,code,reason,elapsedMs})+'\n');
      },
    });
    const account=createAccountService({
      pool,identity,origin:config.origin,runnerProfiles:config.runnerProfiles,executeTasks:config.executeTasks,storyAssistance:config.storyAssistance,
      repositoryStore:config.artifactProvider==='postgres'?new PostgresArtifactStore(pool):undefined,projectConfigSecret:config.secret,
    });
    const app={handle:(request:Request)=>/^\/api\/(?:account|runner)\//.test(new URL(request.url).pathname)
      ?account.handle(request):identity.handle(request)};
    runtime=createCloudRuntime({
      pool,schema:config.schema,origin:config.origin,port:config.port,
      handle:createAccountWebHandler(app,config.origin,resolve('dist/account'),resolve('dist/runner')),
    });
    startupStage='schema';
    await runtime.listen();serving=true;
    process.stdout.write('Cloud identity service ready\n');
    let stopping:Promise<void>|undefined;
    const stop=()=>{
      if(stopping)return;
      stopping=runtime!.close().then(()=>pool.end()).catch(()=>{
        process.stderr.write('Cloud identity shutdown failed; inspect service health\n');process.exitCode=1;
      });
    };
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }finally{
    if(!serving){await runtime?.close().catch(()=>{});await pool.end().catch(()=>{});}
  }
}

main().catch(error=>{
  const message=error instanceof Error&&error.message==='Cloud identity has no command modes'
    ?error.message:'Cloud identity startup failed; verify private configuration and migrated schema';
  const rawCode=error&&typeof error==='object'&&'code' in error?String(error.code):'';
  const code=/^(?:[0-9A-Z]{5}|E(?:CONNREFUSED|TIMEDOUT|N[O]?ENT|HOSTUNREACH))$/.test(rawCode)?rawCode:
    error instanceof Error&&error.message==='Cloud schema verification failed'?'SCHEMA_MISMATCH':'UNKNOWN';
  process.stderr.write(message+' '+JSON.stringify({stage:startupStage,code})+'\n');process.exitCode=1;
});
