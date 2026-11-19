import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createDrainingHttpServer} from './local-server.ts';
import {localIdentityMigrations} from './local-runtime.ts';

export type CloudMigrationRecord={version:number;file:string;checksum:string};
type MigrationRow={version:unknown;checksum:unknown};
type QueryResult={rowCount:number|null;rows:unknown[]};
export type CloudMigrationPool={query:(text:string)=>Promise<QueryResult>};

export async function readCloudMigrationManifest():Promise<readonly CloudMigrationRecord[]>{
  return Promise.all(localIdentityMigrations.map(async(file,index)=>{
    const sql=await readFile(new URL('./migrations/'+file,import.meta.url),'utf8');
    return {version:index+1,file,checksum:createHash('sha256').update(sql).digest('hex')};
  }));
}

/** Startup gate only: a single read verifies the pre-provisioned schema. */
export async function verifyCloudMigrationChecksums(
  pool:CloudMigrationPool,schema:string,manifest:readonly CloudMigrationRecord[],
):Promise<void>{
  if(!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw Error('Cloud schema verification failed');
  const result=await pool.query(`SELECT version,checksum FROM "${schema}".migration_version ORDER BY version`);
  const rows=result.rows as MigrationRow[];
  if(result.rowCount!==manifest.length||rows.length!==manifest.length||rows.some((row,index)=>
    row.version!==manifest[index]?.version||row.checksum!==manifest[index]?.checksum))
    throw Error('Cloud schema verification failed');
}

function denied(request:IncomingMessage,response:ServerResponse,status:number){
  request.resume();
  response.writeHead(status,{
    'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',Connection:'close',
  });
  response.end(JSON.stringify({error:{code:'service_denied'}}));
}

export function createCloudRuntime(options:{
  pool:CloudMigrationPool;
  schema:string;
  origin:string;
  port:number;
  handle:(request:IncomingMessage,response:ServerResponse)=>Promise<void>;
}){
  const origin=new URL(options.origin);
  if(origin.origin!==options.origin||origin.protocol!=='https:')throw Error('Cloud runtime requires an exact HTTPS origin');
  const handle=async(request:IncomingMessage,response:ServerResponse)=>{
    if(!request.url?.startsWith('/')||request.url.startsWith('//')||/[\\#\s]/.test(request.url)){
      denied(request,response,400);return;
    }
    const target=new URL(request.url,origin);
    if(target.pathname==='/health'){
      if(request.method!=='GET'||target.search){denied(request,response,404);return;}
      request.resume();
      response.writeHead(200,{
        'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Length':11,'X-MAS-Release':'f196adaa288e3774156fb6f6f3acc4cf0b0aee5bc25c9896c5d7ebb8fa709cb4',
      });
      response.end('{"ok":true}');
      return;
    }
    if(request.headers.host!==origin.host){denied(request,response,403);return;}
    await options.handle(request,response);
  };
  const draining=createDrainingHttpServer(handle,{
    maxHeaderSize:16_384,headersTimeout:5_000,requestTimeout:5_000,keepAliveTimeout:1_000,
  });
  let listening=false;
  return {
    server:draining.server,
    async listen(){
      if(listening)throw Error('Cloud runtime is already listening');
      const manifest=await readCloudMigrationManifest();
      await verifyCloudMigrationChecksums(options.pool,options.schema,manifest);
      draining.server.listen(options.port,'0.0.0.0');
      try{await once(draining.server,'listening');listening=true;}
      catch(error){await draining.close();throw error;}
    },
    close:draining.close,
  };
}
