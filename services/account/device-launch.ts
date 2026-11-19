import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {projectTransaction} from './project-scope.ts';
import {runnerCredential} from './runner-connections.ts';

const actor=z.object({identityId:z.string().min(1).max(128)}).strict();
const uuid=z.uuid().transform(value=>value.toLowerCase());
const attachInput=z.object({ticket:z.string().regex(/^[a-f0-9]{64}$/),runnerId:uuid,name:z.string().trim().min(1).max(80)}).strict();
const launchPath=/^\/api\/account\/device-launch\/([^/]+)$/;
const confirmPath=/^\/api\/account\/device-launch\/([^/]+)\/confirm$/;
type Launch={id:string;user_id:string;ticket_hash:string;verification_code:string;expires_at:Date;runner_id:string|null;credential_hash:string|null;attached_at:Date|null;confirmed_at:Date|null};
type Device={id:string;owner_id:string|null;name:string;credential_hash:string;pairing_until:Date|null;revoked_at:Date|null;session_until:Date|null};

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const sameHash=(left:string,right:string)=>timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
async function dbNow(client:PoolClient){return Math.floor(Number((await client.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0].ms));}

export function deviceLaunchRoute(request:Request){
  const path=new URL(request.url).pathname;
  return request.method==='POST'&&path==='/api/account/device-launch'||
    request.method==='GET'&&launchPath.test(path)||request.method==='POST'&&confirmPath.test(path);
}

async function currentUser(client:PoolClient,principal:IdentityPrincipal,lock:'UPDATE'|'SHARE'){
  const user=(await client.query<{id:string;status:string}>(`SELECT id,status FROM mas_business_user
    WHERE identity_id=$1 FOR ${lock}`,[principal.id])).rows[0];
  if(!user)throw 404;if(user.status!=='active')throw 403;return user;
}

async function snapshot(client:PoolClient,principal:IdentityPrincipal,launch:Launch,now:number){
  const base={identityId:principal.id,id:launch.id,expiresAt:launch.expires_at.getTime(),verificationCode:launch.verification_code};
  if(!launch.confirmed_at&&launch.expires_at.getTime()<=now)return {...base,status:'expired' as const,device:null};
  if(!launch.runner_id)return {...base,status:'waiting' as const,device:null};
  const device=(await client.query<Device>('SELECT * FROM mas_business_runner_device WHERE id=$1',[launch.runner_id])).rows[0];
  if(!device||device.revoked_at||!launch.credential_hash||!sameHash(device.credential_hash,launch.credential_hash)||
    (device.owner_id&&device.owner_id!==launch.user_id))throw 403;
  return {...base,status:(launch.confirmed_at||device.owner_id===launch.user_id?'connected':'confirm') as 'connected'|'confirm',
    device:{runnerId:device.id,name:device.name,online:device.revoked_at===null&&!!device.session_until&&device.session_until.getTime()>now}};
}

async function start(pool:Pool,principal:IdentityPrincipal,input:z.infer<typeof actor>){
  if(input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    await client.query(`INSERT INTO mas_business_user(id,identity_id,name) VALUES ($1,$2,$3)
      ON CONFLICT(identity_id) DO NOTHING`,[randomUUID(),principal.id,principal.name]);
    const user=await currentUser(client,principal,'UPDATE'),now=await dbNow(client);
    // A new explicit launch supersedes unattached tabs. Attached devices still
    // require confirmation and count against the bounded per-user pending set.
    await client.query(`UPDATE mas_business_device_launch SET expires_at=clock_timestamp()
      WHERE user_id=$1 AND runner_id IS NULL AND confirmed_at IS NULL AND expires_at>clock_timestamp()`,[user.id]);
    await client.query(`DELETE FROM mas_business_device_launch WHERE id IN (
      SELECT id FROM mas_business_device_launch WHERE user_id=$1 AND confirmed_at IS NULL AND expires_at<=clock_timestamp()
      ORDER BY created_at DESC,id DESC OFFSET 20)`,[user.id]);
    await client.query(`DELETE FROM mas_business_device_launch WHERE user_id=$1 AND confirmed_at IS NOT NULL AND
      (confirmed_at<clock_timestamp()-interval '1 day' OR id IN (
        SELECT id FROM mas_business_device_launch WHERE user_id=$1 AND confirmed_at IS NOT NULL
        ORDER BY confirmed_at DESC,id DESC OFFSET 100))`,[user.id]);
    const pending=(await client.query(`SELECT count(*)::int n FROM mas_business_device_launch
      WHERE user_id=$1 AND runner_id IS NOT NULL AND confirmed_at IS NULL AND expires_at>clock_timestamp()`,[user.id])).rows[0].n as number;
    if(pending>=5)throw 429;
    const id=randomUUID(),ticket=randomBytes(32).toString('hex'),verificationCode=randomBytes(3).toString('hex').toUpperCase(),expiresAt=now+300_000;
    await client.query(`INSERT INTO mas_business_device_launch
      (id,user_id,ticket_hash,verification_code,expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [id,user.id,hash(ticket),verificationCode,new Date(expiresAt)]);
    return {identityId:principal.id,id,ticket,expiresAt,verificationCode};
  });
}

async function read(pool:Pool,principal:IdentityPrincipal,id:string){
  return projectTransaction(pool,async client=>{
    const user=await currentUser(client,principal,'SHARE');
    const launch=(await client.query<Launch>('SELECT * FROM mas_business_device_launch WHERE id=$1 AND user_id=$2',[id,user.id])).rows[0];
    if(!launch)throw 404;return snapshot(client,principal,launch,await dbNow(client));
  });
}

async function confirm(pool:Pool,principal:IdentityPrincipal,id:string,input:z.infer<typeof actor>){
  if(input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    const user=await currentUser(client,principal,'UPDATE');
    const launch=(await client.query<Launch>('SELECT * FROM mas_business_device_launch WHERE id=$1 AND user_id=$2 FOR UPDATE',[id,user.id])).rows[0];
    if(!launch)throw 404;
    if(!launch.runner_id||!launch.credential_hash)throw 409;
    const device=(await client.query<Device>('SELECT * FROM mas_business_runner_device WHERE id=$1 FOR UPDATE',[launch.runner_id])).rows[0];
    if(!device||device.revoked_at||!sameHash(device.credential_hash,launch.credential_hash)||
      (device.owner_id&&device.owner_id!==user.id))throw 403;
    if(!launch.confirmed_at){
      if(launch.expires_at.getTime()<=await dbNow(client))throw 409;
      if(!device.owner_id){
        const retained=(await client.query('SELECT count(*)::int n FROM mas_business_runner_device WHERE owner_id=$1',[user.id])).rows[0].n as number;
        if(retained>=100)throw 409;
        await client.query('UPDATE mas_business_runner_device SET owner_id=$2,pairing_until=NULL WHERE id=$1',[device.id,user.id]);
        device.owner_id=user.id;device.pairing_until=null;
      }
      await client.query('UPDATE mas_business_device_launch SET confirmed_at=clock_timestamp() WHERE id=$1',[launch.id]);
      launch.confirmed_at=new Date();
    }
    return snapshot(client,principal,launch,await dbNow(client));
  });
}

export async function handleDeviceLaunch(pool:Pool,principal:IdentityPrincipal,request:Request){
  const path=new URL(request.url).pathname;
  if(path==='/api/account/device-launch'&&request.method==='POST')return start(pool,principal,actor.parse(await readBoundedJson(request,8192)));
  const confirmation=confirmPath.exec(path);
  if(confirmation&&request.method==='POST')return confirm(pool,principal,z.uuid().parse(confirmation[1]),actor.parse(await readBoundedJson(request,8192)));
  const status=launchPath.exec(path);
  if(status&&request.method==='GET')return read(pool,principal,z.uuid().parse(status[1]));
  throw 404;
}

/** Native bearer proof selects one Runner for one launch. It never grants an
 * unowned Runner to the Web account and never creates an Agent or project. */
export async function handleDeviceLaunchAttach(pool:Pool,request:Request){
  if(request.method!=='POST'||new URL(request.url).pathname!=='/api/runner/launch/attach')throw 404;
  const credentialHash=runnerCredential(request),input=attachInput.parse(await readBoundedJson(request,8192)),ticketHash=hash(input.ticket);
  return projectTransaction(pool,async client=>{
    const observed=(await client.query<{user_id:string}>('SELECT user_id FROM mas_business_device_launch WHERE ticket_hash=$1',[ticketHash])).rows[0];
    if(!observed)throw 404;
    const user=(await client.query<{id:string;status:string}>('SELECT id,status FROM mas_business_user WHERE id=$1 FOR UPDATE',[observed.user_id])).rows[0];
    if(!user||user.status!=='active')throw 403;
    const launch=(await client.query<Launch>('SELECT * FROM mas_business_device_launch WHERE ticket_hash=$1 AND user_id=$2 FOR UPDATE',[ticketHash,user.id])).rows[0];
    if(!launch)throw 404;if(launch.expires_at.getTime()<=await dbNow(client))throw 409;
    if(launch.runner_id){
      if(launch.runner_id!==input.runnerId||!launch.credential_hash||!sameHash(launch.credential_hash,credentialHash))throw 409;
      const device=(await client.query<Device>('SELECT * FROM mas_business_runner_device WHERE id=$1 FOR UPDATE',[input.runnerId])).rows[0];
      if(!device||device.revoked_at||!sameHash(device.credential_hash,credentialHash)||
        (device.owner_id&&device.owner_id!==user.id))throw 403;
      await client.query('UPDATE mas_business_runner_device SET name=$2 WHERE id=$1',[device.id,input.name]);
      return {ok:true as const,verificationCode:launch.verification_code,launchId:launch.id};
    }

    const before=(await client.query<{owner_id:string|null}>('SELECT owner_id FROM mas_business_runner_device WHERE id=$1',[input.runnerId])).rows[0];
    // Pairing and launch share admission capacity. Take this before any device
    // row lock so pair/bind/confirm cannot form a lock-order cycle.
    if(!before?.owner_id)await client.query("SELECT pg_advisory_xact_lock(hashtext('mas_business_runner_pair'))");
    let device=(await client.query<Device>('SELECT * FROM mas_business_runner_device WHERE id=$1 FOR UPDATE',[input.runnerId])).rows[0];
    if(device){
      if(!sameHash(device.credential_hash,credentialHash)||
        (device.owner_id&&device.owner_id!==user.id)||
        (device.revoked_at&&device.owner_id!==user.id))throw 403;
      // A revoked installation retains its local identity. Only a fresh,
      // short-lived launch from its original owner plus the native credential
      // may explicitly reauthorize it; ordinary Runner traffic remains denied.
      if(device.owner_id){
        if(device.revoked_at)await client.query(`UPDATE mas_business_runner_device SET name=$2,
          revoked_at=NULL,session_hash=NULL,session_until=NULL WHERE id=$1`,[device.id,input.name]);
        else await client.query('UPDATE mas_business_runner_device SET name=$2 WHERE id=$1',[device.id,input.name]);
      }
      else await client.query(`UPDATE mas_business_runner_device SET name=$2,pairing_hash=$3,pairing_until=$4 WHERE id=$1`,
        [device.id,input.name,randomBytes(32).toString('hex'),launch.expires_at]);
      device.revoked_at=null;
      device.name=input.name;
    }else{
      await client.query(`DELETE FROM mas_business_runner_device d WHERE d.owner_id IS NULL AND d.pairing_until<=clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM mas_business_device_launch l WHERE l.runner_id=d.id AND l.expires_at>clock_timestamp())`);
      const pending=(await client.query('SELECT count(*)::int n FROM mas_business_runner_device WHERE owner_id IS NULL')).rows[0].n as number;
      if(pending>=1000)throw 429;
      // Compatibility columns retain an undisclosed random hash/deadline. No
      // manual pairing code is returned or accepted by the launch flow.
      await client.query(`INSERT INTO mas_business_runner_device
        (id,name,credential_hash,pairing_hash,pairing_until) VALUES ($1,$2,$3,$4,$5)`,
      [input.runnerId,input.name,credentialHash,randomBytes(32).toString('hex'),launch.expires_at]);
      device={id:input.runnerId,name:input.name,owner_id:null,credential_hash:credentialHash,pairing_until:launch.expires_at,revoked_at:null,session_until:null};
    }
    const connected=device.owner_id===user.id;
    await client.query(`UPDATE mas_business_device_launch SET runner_id=$2,credential_hash=$3,attached_at=clock_timestamp(),
      confirmed_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END WHERE id=$1`,
    [launch.id,device.id,credentialHash,connected]);
    return {ok:true as const,verificationCode:launch.verification_code,launchId:launch.id};
  });
}
