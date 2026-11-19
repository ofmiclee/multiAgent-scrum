import {randomUUID} from 'node:crypto';
import {isAbsolute,resolve} from 'node:path';
import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {authorizeProject,projectTransaction} from './project-scope.ts';
import {authorizeRunnerSession,runnerCredential,runnerSessionSchema} from './runner-connections.ts';
import type {ProjectSecrets} from './project-secrets.ts';

const webPath=/^\/api\/account\/projects\/([^/]+)\/files\/directory-pick(?:\/([^/]+))?$/;
const runnerPath=/^\/api\/runner\/project-setup\/(directory-poll|directory-finish)$/;
const startSchema=z.object({runnerId:z.uuid()}).strict();
const directorySchema=z.string().min(2).max(1024).refine(value=>isAbsolute(value)&&resolve(value)===value&&value!=='/'&&!/[\x00-\x1f\x7f]/.test(value));
const finishSchema=runnerSessionSchema.extend({id:z.uuid(),result:z.enum(['selected','cancelled','unavailable']),directory:directorySchema.optional()}).strict();
type Pick={id:string;project_id:string;user_id:string;runner_id:string;state:string;session_hash:string|null;encrypted_directory:string|null;expires_at:Date};
const scope=(id:string)=>`directory-pick:${id}`;

export function directoryPickWebRoute(request:Request){const path=new URL(request.url).pathname;return webPath.test(path)&&['GET','POST'].includes(request.method);}
export function directoryPickRunnerRoute(request:Request){return request.method==='POST'&&runnerPath.test(new URL(request.url).pathname);}

export async function handleDirectoryPickWeb(pool:Pool,principal:IdentityPrincipal,request:Request,secrets:ProjectSecrets){
  const match=webPath.exec(new URL(request.url).pathname);if(!match)throw 404;
  const projectId=z.uuid().parse(match[1]),pickId=match[2]?z.uuid().parse(match[2]):undefined;
  if(request.method==='POST'&&!pickId){
    const input=startSchema.parse(await readBoundedJson(request,8192));
    return projectTransaction(pool,async client=>{
      const user=await authorizeProject(client,principal.id,projectId,true);
      const device=(await client.query<{id:string}>(`SELECT id FROM mas_business_runner_device
        WHERE id=$1 AND owner_id=$2 AND revoked_at IS NULL AND session_until>clock_timestamp() FOR UPDATE`,[input.runnerId,user.id])).rows[0];
      if(!device)throw 409;
      await client.query(`UPDATE mas_business_directory_pick SET state='expired',updated_at=clock_timestamp()
        WHERE runner_id=$1 AND state IN ('queued','running') AND expires_at<=clock_timestamp()`,[device.id]);
      const pending=(await client.query<{id:string;project_id:string;user_id:string}>(`SELECT id,project_id,user_id FROM mas_business_directory_pick
        WHERE runner_id=$1 AND state IN ('queued','running') ORDER BY created_at LIMIT 1`,[device.id])).rows[0];
      if(pending){if(pending.project_id!==projectId||pending.user_id!==user.id)throw 409;return {id:pending.id};}
      const id=randomUUID();
      await client.query(`INSERT INTO mas_business_directory_pick(id,project_id,user_id,runner_id,expires_at)
        VALUES($1,$2,$3,$4,clock_timestamp()+interval '10 minutes')`,[id,projectId,user.id,device.id]);
      return {id};
    });
  }
  if(request.method==='GET'&&pickId){
    return projectTransaction(pool,async client=>{
      const user=await authorizeProject(client,principal.id,projectId,false);
      const row=(await client.query<Pick>(`SELECT * FROM mas_business_directory_pick
        WHERE id=$1 AND project_id=$2 AND user_id=$3`,[pickId,projectId,user.id])).rows[0];
      if(!row)throw 404;
      const state=row.expires_at.getTime()<=Date.now()?'expired':row.state;
      return {id:row.id,state,directory:state==='selected'&&row.encrypted_directory?secrets.open<string>(row.encrypted_directory,scope(row.id)):null};
    });
  }
  throw 404;
}

export async function handleDirectoryPickRunner(pool:Pool,request:Request,secrets:ProjectSecrets){
  const action=runnerPath.exec(new URL(request.url).pathname)?.[1];if(!action)throw 404;
  const credential=runnerCredential(request),raw=await readBoundedJson(request,8192);
  const input=action==='directory-poll'?runnerSessionSchema.parse(raw):finishSchema.parse(raw);
  if(action==='directory-finish'){
    const finish=input as z.infer<typeof finishSchema>;
    if((finish.result==='selected')!==!!finish.directory)throw 400;
  }
  return projectTransaction(pool,async client=>{
    const context=await authorizeRunnerSession(client,input,credential);
    await client.query(`UPDATE mas_business_directory_pick SET state='expired',updated_at=clock_timestamp()
      WHERE runner_id=$1 AND state IN ('queued','running') AND expires_at<=clock_timestamp()`,[input.runnerId]);
    if(action==='directory-poll'){
      const row=(await client.query<Pick>(`SELECT * FROM mas_business_directory_pick
        WHERE runner_id=$1 AND user_id=$2 AND state='queued' ORDER BY created_at LIMIT 1 FOR UPDATE`,[input.runnerId,context.user.id])).rows[0];
      if(!row)return {job:null};
      await client.query(`UPDATE mas_business_directory_pick SET state='running',session_hash=$2,updated_at=clock_timestamp() WHERE id=$1`,[row.id,context.device.session_hash]);
      return {job:{id:row.id}};
    }
    const finish=input as z.infer<typeof finishSchema>;
    const row=(await client.query<Pick>('SELECT * FROM mas_business_directory_pick WHERE id=$1 AND runner_id=$2 AND user_id=$3 FOR UPDATE',[finish.id,input.runnerId,context.user.id])).rows[0];
    if(!row||row.session_hash!==context.device.session_hash)throw 409;
    if(row.state===finish.result){
      if(finish.result==='selected'&&secrets.open<string>(row.encrypted_directory!,scope(row.id))!==finish.directory)throw 409;
      return {ok:true};
    }
    if(row.state!=='running')throw 409;
    await client.query(`UPDATE mas_business_directory_pick SET state=$2,encrypted_directory=$3,updated_at=clock_timestamp() WHERE id=$1`,
      [row.id,finish.result,finish.directory?secrets.seal(finish.directory,scope(row.id)):null]);
    return {ok:true};
  });
}
