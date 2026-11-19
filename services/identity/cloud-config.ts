import {isIP} from 'node:net';
import type {PoolConfig} from 'pg';
import type {RunnerProfile} from '../../packages/domain/runner-protocol.ts';
import {githubRelayConfig,type GithubRelay} from './github-relay.ts';

export const CLOUD_IDENTITY_ORIGIN='https://scrum.fruitbuddy.cn';

export type CloudIdentityConfig={
  origin:typeof CLOUD_IDENTITY_ORIGIN;
  port:number;
  schema:'mas_identity';
  secret:string;
  github:{clientId:string;clientSecret:string;relay?:GithubRelay};
  runnerProfiles:readonly RunnerProfile[];
  executeTasks:boolean;
  storyAssistance:boolean;
  artifactProvider?:'postgres';
  database:PoolConfig&{ssl:{host:string;ca:string;rejectUnauthorized:true}};
};

function required(environment:NodeJS.ProcessEnv,name:string){
  const value=environment[name];
  if(!value)throw Error(`${name} is required`);
  return value;
}

function integer(environment:NodeJS.ProcessEnv,name:string,min:number,max:number){
  const raw=required(environment,name);
  if(!/^\d+$/.test(raw))throw Error(`${name} is outside its allowed range`);
  const value=Number(raw);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`${name} is outside its allowed range`);
  return value;
}

function identifier(value:string,label:string){
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw Error(`Invalid PostgreSQL ${label}`);
  return value;
}

function privateHost(value:string){
  if(value!==value.trim()||value.length>253||/[\/@:#?\[\]]/.test(value)||
    !/^[a-zA-Z0-9.-]+$/.test(value)||value.startsWith('.')||value.endsWith('.')||value.includes('..'))
    throw Error('Invalid private PostgreSQL host');
  const ip=isIP(value);
  if(ip===4){
    const [a,b]=value.split('.').map(Number);
    if(!(a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168)))
      throw Error('PostgreSQL host must be a private endpoint');
  }else if(ip!==0||value==='localhost'||value.endsWith('.localhost')){
    throw Error('PostgreSQL host must be a private endpoint');
  }
  return value;
}

function tlsCa(environment:NodeJS.ProcessEnv){
  const encoded=required(environment,'MAS_PG_TLS_CA_BASE64');
  if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)||encoded.length%4!==0)
    throw Error('Verified PostgreSQL TLS CA is required');
  const decoded=Buffer.from(encoded,'base64').toString('utf8');
  const ca=decoded.endsWith('\n')?decoded.slice(0,-1):decoded;
  if(!/^-----BEGIN CERTIFICATE-----\n[^\0]+\n-----END CERTIFICATE-----$/.test(ca))
    throw Error('Verified PostgreSQL TLS CA is required');
  return ca;
}

/** Strict production-only configuration. It intentionally has no URL-shaped
 * database input, local mail switch, provisioning mode, or credential defaults. */
export function cloudIdentityConfig(environment:NodeJS.ProcessEnv=process.env):CloudIdentityConfig{
  if(environment.NODE_ENV!=='production')throw Error('Cloud identity requires production mode');
  if(environment.MAS_PUBLIC_ORIGIN!==CLOUD_IDENTITY_ORIGIN)throw Error('Cloud identity origin is fixed');
  if(environment.DATABASE_URL!==undefined)throw Error('Database URLs are not accepted');
  if(environment.MAS_IDENTITY_LOCAL_MAIL!==undefined||environment.MAS_IDENTITY_PORT!==undefined)
    throw Error('Local identity settings are not accepted');
  if(environment.MAS_IDENTITY_MODE!==undefined)throw Error('Cloud identity has no command mode');
  if(environment.NODE_TLS_REJECT_UNAUTHORIZED==='0'||environment.PGSSLMODE!==undefined)
    throw Error('Verified TLS cannot be overridden');

  const schema=required(environment,'MAS_PG_SCHEMA');
  if(schema!=='mas_identity')throw Error('Cloud identity requires the production schema');
  const user=identifier(required(environment,'MAS_PG_USER'),'role');
  if(/(?:^|_)(?:postgres|root|admin|owner|superuser)(?:_|$)/.test(user))
    throw Error('Administrative PostgreSQL roles are not accepted');
  const secret=required(environment,'MAS_IDENTITY_SECRET');
  if(!/^[a-f0-9]{64}$/i.test(secret)||new Set(secret).size<8)throw Error('MAS_IDENTITY_SECRET is required and invalid');
  const clientId=required(environment,'MAS_GITHUB_CLIENT_ID');
  const clientSecret=required(environment,'MAS_GITHUB_CLIENT_SECRET');
  if([clientId,clientSecret].some(value=>value.length>512||/\s/.test(value)))
    throw Error('GitHub credentials are required and invalid');
  const taskChannel=environment.ENABLE_ACCOUNT_RUNNER_TASKS==='1';
  const runnerProfiles:RunnerProfile[]=[];
  if(environment.ENABLE_ACCOUNT_RUNNER_DSH_TASKS==='1'){
    if(!taskChannel)throw Error('Formal DSH channel requires explicit task-channel opt-in');
    runnerProfiles.push('dsh-text');
  }
  if(environment.ENABLE_ACCOUNT_RUNNER_CODEX_TASKS==='1'){
    if(!taskChannel)throw Error('Formal Codex channel requires explicit task-channel opt-in');
    runnerProfiles.push('codex-code');
  }
  const executeTasks=environment.ENABLE_ACCOUNT_RUNNER_EXECUTION==='1';
  if(executeTasks&&!runnerProfiles.length)throw Error('Execution requires an explicit formal Runner profile');
  const host=privateHost(required(environment,'MAS_PG_PRIVATE_HOST'));
  const artifactProvider=environment.MAS_ARTIFACT_PROVIDER;
  if(artifactProvider!==undefined&&artifactProvider!=='postgres')throw Error('Unsupported private artifact provider');

  return {
    origin:CLOUD_IDENTITY_ORIGIN,
    port:integer(environment,'PORT',1024,65535),
    schema,
    secret,
    github:{clientId,clientSecret,...(environment.MAS_GITHUB_RELAY_ORIGIN!==undefined||environment.MAS_GITHUB_RELAY_KEY!==undefined?{relay:githubRelayConfig(environment)}:{})},
    runnerProfiles,
    executeTasks,
    storyAssistance:environment.ENABLE_ACCOUNT_STORY_ASSISTANCE==='1',
    artifactProvider,
    database:{
      host,
      port:integer(environment,'MAS_PG_PORT',1,65535),
      database:identifier(required(environment,'MAS_PG_DATABASE'),'database'),
      user,
      password:required(environment,'MAS_PG_PASSWORD'),
      options:`-c search_path=${schema}`,
      max:integer(environment,'MAS_PG_POOL_MAX',1,20),
      connectionTimeoutMillis:integer(environment,'MAS_PG_CONNECT_TIMEOUT_MS',500,30000),
      statement_timeout:integer(environment,'MAS_PG_STATEMENT_TIMEOUT_MS',1000,60000),
      ssl:{host,ca:tlsCa(environment),rejectUnauthorized:true},
    },
  };
}
