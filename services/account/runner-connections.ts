import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {readBoundedJson} from '../identity/request.ts';
import {projectTransaction} from './project-scope.ts';

const key=z.string().regex(/^[a-f0-9]{64}$/),ref=z.object({runnerId:z.uuid()}).strict();
const pairing=ref.extend({name:z.string().trim().min(1).max(80),credentialHash:key}).strict();
const session=ref.extend({sessionId:key}).strict();
export const hashRunnerSecret=(value:string)=>createHash('sha256').update(value).digest('hex');
export const runnerSessionSchema=session;
type Device={id:string;owner_id:string|null;credential_hash:string;revoked_at:Date|null;session_hash:string|null;session_until:Date|null};
async function dbNow(client:PoolClient){return Number((await client.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0].ms);}
function sameHash(left:string,right:string){return timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));}

export function runnerCredential(request:Request){
  if(['origin','cookie','sec-fetch-mode','sec-fetch-site','sec-fetch-dest'].some(h=>request.headers.has(h)))throw 403;
  const token=/^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization')??'')?.[1];
  if(!token)throw 403;return hashRunnerSecret(token);
}

/** Caller owns the transaction. Mutating execution paths serialize on the
 * resource owner's user row before device/project/Agent/task locks. */
export async function authorizeRunnerSession(client:PoolClient,input:z.infer<typeof session>,digest:string){
  const owner=(await client.query<{owner_id:string|null}>('SELECT owner_id FROM mas_business_runner_device WHERE id=$1',[input.runnerId])).rows[0];
  if(!owner?.owner_id)throw 428;
  const user=(await client.query<{id:string;identity_id:string;status:string}>('SELECT id,identity_id,status FROM mas_business_user WHERE id=$1 FOR UPDATE',[owner.owner_id])).rows[0];
  if(user?.status!=='active')throw 403;
  const device=(await client.query<Device>('SELECT * FROM mas_business_runner_device WHERE id=$1 FOR UPDATE',[input.runnerId])).rows[0];
  if(!device||device.owner_id!==user.id||device.revoked_at||!sameHash(device.credential_hash,digest))throw 403;
  const now=await dbNow(client);
  if(!device.session_hash||!device.session_until||device.session_until.getTime()<=now||!sameHash(device.session_hash,hashRunnerSecret(input.sessionId)))throw 409;
  return {user,device,now};
}

/** Connection only. It cannot register an Agent, claim a task or grant a project. */
export async function handleRunnerConnection(pool:Pool,request:Request){
  const path=new URL(request.url).pathname;
  if(request.method!=='POST'||!/^\/api\/runner\/(pair|connect|heartbeat|disconnect|status)$/.test(path))throw 404;
  const digest=runnerCredential(request),body=await readBoundedJson(request,8192);
  if(path.endsWith('/status')){
    const input=ref.parse(body);
    return projectTransaction(pool,async client=>{
      const device=(await client.query<Device & {user_status:string}>(`SELECT d.*,u.status AS user_status
        FROM mas_business_runner_device d JOIN mas_business_user u ON u.id=d.owner_id WHERE d.id=$1`,[input.runnerId])).rows[0];
      if(!device||device.user_status!=='active'||device.revoked_at||!sameHash(device.credential_hash,digest))throw 403;
      const state=(await client.query<{connected:boolean;agent_count:number;ready_agent_count:number}>(`SELECT
        (d.session_until>clock_timestamp()) IS TRUE AS connected,
        count(a.id)::int AS agent_count,
        count(a.id) FILTER (WHERE a.enabled AND a.ready_until>clock_timestamp() AND a.ready_session_hash=d.session_hash)::int AS ready_agent_count
        FROM mas_business_runner_device d LEFT JOIN mas_business_agent a ON a.runner_id=d.id AND a.deleted_at IS NULL
        WHERE d.id=$1 GROUP BY d.id`,[input.runnerId])).rows[0];
      return {connected:state.connected,agentCount:state.agent_count,readyAgentCount:state.ready_agent_count};
    });
  }
  if(path.endsWith('/pair')){
    const input=pairing.parse(body);
    if(!sameHash(input.credentialHash,digest))throw 403;
    return projectTransaction(pool,async client=>{
      // Serializes pending-admission counts and same-ID first use. Bound-device
      // heartbeat traffic never takes this lock. No runtime DDL.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('mas_business_runner_pair'))");
      const previous=(await client.query<Device>('SELECT * FROM mas_business_runner_device WHERE id=$1 FOR UPDATE',[input.runnerId])).rows[0];
      if(previous&&!sameHash(previous.credential_hash,digest))throw 403;
      if(previous?.owner_id||previous?.revoked_at)throw 409;
      // Only unbound, expired requests are disposable; bound/revoked IDs persist.
      await client.query('DELETE FROM mas_business_runner_device WHERE owner_id IS NULL AND pairing_until<=clock_timestamp() AND id<>$1',[input.runnerId]);
      if(!previous&&(await client.query('SELECT count(*)::int n FROM mas_business_runner_device WHERE owner_id IS NULL')).rows[0].n>=1000)throw 429;
      const code=randomBytes(8).toString('hex').toUpperCase(),expiresAt=await dbNow(client)+300_000;
      await client.query(`INSERT INTO mas_business_runner_device(id,name,credential_hash,pairing_hash,pairing_until)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        pairing_hash=excluded.pairing_hash,pairing_until=excluded.pairing_until`,
      [input.runnerId,input.name,digest,hashRunnerSecret(code),new Date(expiresAt)]);
      return {code,expiresAt};
    });
  }
  // Accept an old catalog payload during rolling upgrades, but never persist
  // or consult it. System-owned catalog rows are the model authority.
  const input=path.endsWith('/connect')?ref.parse(body):path.endsWith('/heartbeat')?session.extend({catalogs:z.unknown().optional()}).strict().parse(body):session.parse(body);
  return projectTransaction(pool,async client=>{
    // Immutable owner lookup, then user -> device locks (same order as Web).
    const owner=(await client.query<Device>('SELECT owner_id FROM mas_business_runner_device WHERE id=$1',[input.runnerId])).rows[0];
    if(!owner)throw 428;
    if(owner.owner_id){
      const user=(await client.query('SELECT status FROM mas_business_user WHERE id=$1 FOR SHARE',[owner.owner_id])).rows[0];
      if(user?.status!=='active')throw 403;
    }
    const device=(await client.query<Device>('SELECT * FROM mas_business_runner_device WHERE id=$1 FOR UPDATE',[input.runnerId])).rows[0];
    if(!device)throw 428;
    if(device.revoked_at||!sameHash(device.credential_hash,digest))throw 403;
    // If a concurrent Web bind changed the null owner, retry in correct lock order.
    if(!device.owner_id||device.owner_id!==owner.owner_id)throw 428;
    const now=await dbNow(client);
    if(path.endsWith('/connect')){
      if(device.session_until&&device.session_until.getTime()>now)throw 409;
      const sessionId=randomBytes(32).toString('hex');
      await client.query('UPDATE mas_business_runner_device SET session_hash=$2,session_until=$3,last_seen=$4 WHERE id=$1',
        [input.runnerId,hashRunnerSecret(sessionId),new Date(now+15_000),new Date(now)]);
      return {sessionId,heartbeatMs:4000};
    }
    if(!('sessionId' in input)||typeof input.sessionId!=='string'||!device.session_hash||!device.session_until||device.session_until.getTime()<=now||
      !sameHash(device.session_hash,hashRunnerSecret(input.sessionId)))throw 409;
    if(path.endsWith('/heartbeat')){
      await client.query('UPDATE mas_business_runner_device SET session_until=$2,last_seen=$3 WHERE id=$1',
        [input.runnerId,new Date(now+15_000),new Date(now)]);
    }else await client.query('UPDATE mas_business_runner_device SET session_hash=NULL,session_until=NULL WHERE id=$1',[input.runnerId]);
    return {ok:true,executionReady:false};
  });
}
