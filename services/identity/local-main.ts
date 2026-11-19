import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {localIdentityConfig} from './local-config.ts';
import {createIdentityService} from './service.ts';
import {createAccountService} from '../account/service.ts';
import {createAccountWebHandler} from '../account/web.ts';
import {createLocalIdentityMail} from './local-mail.ts';
import {resolve} from 'node:path';
import {createDrainingHttpServer} from './local-server.ts';
import {localIdentityMigrations,resolveAccountRunnerProfiles} from './local-runtime.ts';

const usage=`Local identity verification (loopback only; separate from the board preview).
  npm run identity:local -- init       Apply versioned SQL to local PG explicitly.
  npm run identity:local               Serve /api/identity on 127.0.0.1:4399.
  npm run identity:local -- provision  Read one private JSON account from stdin.
Serve/provision require MAS_IDENTITY_SECRET (random 32-byte hex, persist privately).
Optional MAS_IDENTITY_PORT: 1024-65535. No defaults or automatic organization grants.
MAS_IDENTITY_LOCAL_MAIL=1 enables verified self-registration and private local mail capture (no real email).
MAS_GITHUB_CLIENT_ID and MAS_GITHUB_CLIENT_SECRET together enable optional GitHub login (no repository access).
Build the account portal with npm run build:account before serving.
Never pass passwords in command arguments. No cloud database configuration is used.\n`;

async function accountInput():Promise<{email:string;name:string;password:string}> {
  if(process.stdin.isTTY)throw Error('Provisioning requires private JSON on stdin');
  let bytes=0;const chunks:Buffer[]=[];
  for await(const value of process.stdin){
    const chunk=Buffer.from(value);bytes+=chunk.length;
    if(bytes>16384)throw Error('Provisioning input rejected');
    chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw Error('Provisioning input rejected');}
}

async function main() {
  const mode=process.argv[2]??'serve';
  if(mode==='--help' && process.argv.length===3){process.stdout.write(usage);return;}
  if(!['serve','init','provision'].includes(mode)||process.argv.length>3)throw Error('Unknown identity command; use --help');
  const config=localIdentityConfig();
  if(mode!=='init' && !process.env.MAS_IDENTITY_SECRET)throw Error('MAS_IDENTITY_SECRET is required; no default credentials');
  const pool=new pg.Pool(config.database);
  pool.on('error',()=>{process.stderr.write('Local identity database connection unavailable\n');});
  let serving=false;
  try {
    const migrations=await Promise.all(localIdentityMigrations.map(async(file,index)=>{
      const sql=await readFile(new URL('./migrations/'+file,import.meta.url),'utf8');
      return {version:index+1,sql,checksum:createHash('sha256').update(sql).digest('hex')};
    }));
    if(mode==='init'){
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('mas_identity_local_init'))");
        const exists=await client.query("SELECT 1 FROM pg_namespace WHERE nspname='mas_identity_local'");
        if(!exists.rowCount){
          await client.query('CREATE SCHEMA mas_identity_local');
          await client.query('CREATE TABLE mas_identity_local.migration_version (version integer PRIMARY KEY, checksum text NOT NULL)');
        }
        await client.query('SET LOCAL search_path=mas_identity_local');
        const recorded=await client.query('SELECT version,checksum FROM mas_identity_local.migration_version ORDER BY version');
        if(recorded.rows.some((row,index)=>row.version!==index+1||row.checksum!==migrations[index]?.checksum))throw Error('Migration version mismatch');
        for(const migration of migrations.slice(recorded.rowCount??0)){
          await client.query(migration.sql);
          await client.query('INSERT INTO mas_identity_local.migration_version VALUES ($1,$2)',[migration.version,migration.checksum]);
        }
        await client.query('COMMIT');
        process.stdout.write('Local identity schema initialized; no accounts created.\n');
      }catch(e){await client.query('ROLLBACK');throw e;}
      finally{client.release();}
      return;
    }
    const recorded=await pool.query('SELECT version,checksum FROM mas_identity_local.migration_version ORDER BY version');
    if(recorded.rowCount!==migrations.length||recorded.rows.some((row,index)=>row.version!==index+1||row.checksum!==migrations[index].checksum))throw Error('Migration version mismatch');
    const mail=process.env.MAS_IDENTITY_LOCAL_MAIL==='1'?{
      ...createLocalIdentityMail(process.cwd(),'.runtime/identity-mail'),
      onError:()=>process.stderr.write('Local identity mail capture failed; check private directory permissions\n'),
    }:undefined;
  const identity=createIdentityService({pool,origin:config.origin,secret:process.env.MAS_IDENTITY_SECRET!,mail,
    onGithubFailure:stage=>{process.stderr.write('GitHub login failed at '+stage+' stage (credential details omitted)\n');},
    onGithubDiagnostic:event=>{process.stderr.write('GitHub diagnostic '+JSON.stringify(event)+'\n');},
    ...(process.env.MAS_GITHUB_CLIENT_ID||process.env.MAS_GITHUB_CLIENT_SECRET?{github:{clientId:process.env.MAS_GITHUB_CLIENT_ID??'',clientSecret:process.env.MAS_GITHUB_CLIENT_SECRET??''}}:{}),
  });
    if(mode==='provision'){
      await identity.provision(await accountInput());
      process.stdout.write('Independent account provisioned; no organization or project access granted.\n');
      return;
    }
    const runnerProfiles=resolveAccountRunnerProfiles(process.env);
    const account=createAccountService({pool,identity,origin:config.origin,runnerProfiles,
      executeTasks:process.env.ENABLE_ACCOUNT_RUNNER_EXECUTION==='1',projectConfigSecret:process.env.MAS_IDENTITY_SECRET});
    const handle=(request:Request)=>/^\/api\/(account|runner)\//.test(new URL(request.url).pathname)?account.handle(request):identity.handle(request);
    const runtime=createDrainingHttpServer(createAccountWebHandler({handle},config.origin,resolve('dist/account'),resolve('dist/runner')),
      {maxHeaderSize:16384,headersTimeout:5000,requestTimeout:5000,keepAliveTimeout:1000});
    const server=runtime.server;
    server.listen(config.port,'127.0.0.1');await once(server,'listening');
    serving=true;
    process.stdout.write(`Local identity listening at ${config.origin}; board preview is unchanged.\n`);
    let closing=false;
    const stop=()=>{
      if(closing)return;closing=true;
      void runtime.close().then(()=>pool.end()).catch(()=>{
        process.stderr.write('Local identity shutdown failed; inspect local service health\n');process.exitCode=1;
      });
    };
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }finally{if(!serving)await pool.end();}
}
main().catch(error=>{
  // Only our actionable pre-connection configuration errors are safe to expose.
  const safe=['Local identity is disabled in production','Invalid local identity port',
    'MAS_IDENTITY_SECRET is required; no default credentials','Unknown identity command; use --help'];
  process.stderr.write((error instanceof Error && safe.includes(error.message)?error.message:
    'Local identity command failed; verify local schema, private configuration and input')+'\n');
  process.exitCode=1;
});
