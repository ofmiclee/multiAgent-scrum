import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {projectTransaction} from './project-scope.ts';
import {hashRunnerSecret} from './runner-connections.ts';

const actorInput=z.object({identityId:z.string().min(1).max(128)}).strict();
const bind=actorInput.extend({code:z.string().regex(/^[A-F0-9]{16}$/),runnerId:z.uuid()}).strict();
export function deviceRoute(request:Request){
  const path=new URL(request.url).pathname;
  return request.method==='GET'&&path==='/api/account/devices'||request.method==='POST'&&
    (path==='/api/account/devices/bind'||/^\/api\/account\/devices\/[^/]+\/revoke$/.test(path));
}
async function ownedDevice(client:PoolClient,userId:string,runnerId:string){
  const result=await client.query(`SELECT id AS "runnerId",name,
    (revoked_at IS NULL AND session_until>clock_timestamp()) IS TRUE AS online,
    extract(epoch FROM last_seen)*1000 AS "lastSeen",revoked_at IS NOT NULL AS revoked,
    false AS "executionReady" FROM mas_business_runner_device WHERE owner_id=$1 AND id=$2`,[userId,runnerId]);
  const row=result.rows[0];if(!row)throw 404;
  return {...row,lastSeen:row.lastSeen===null?null:Number(row.lastSeen)};
}

export async function handleDeviceRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  if(request.method==='GET')return listDevices(pool,principal);
  const path=new URL(request.url).pathname,input=await readBoundedJson(request,8192);
  const binding=path.endsWith('/bind')?bind.parse(input):null;
  const runnerId=binding?.runnerId??z.uuid().parse(path.split('/')[4]);
  if((binding??actorInput.parse(input)).identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    if(binding)await client.query(`INSERT INTO mas_business_user(id,identity_id,name) VALUES ($1,$2,$3)
      ON CONFLICT(identity_id) DO NOTHING`,[randomUUID(),principal.id,principal.name]);
    const user=(await client.query('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR UPDATE',[principal.id])).rows[0];
    if(!user)throw 404;if(user.status!=='active')throw 403;
    const device=(await client.query('SELECT * FROM mas_business_runner_device WHERE id=$1 FOR UPDATE',[runnerId])).rows[0];
    if(binding){
      if(!device||device.revoked_at||device.pairing_hash!==hashRunnerSecret(binding.code)||
        (device.owner_id&&device.owner_id!==user.id))throw 404;
      if(!device.owner_id){
        const valid=(await client.query('SELECT pairing_until>clock_timestamp() AS valid FROM mas_business_runner_device WHERE id=$1',[runnerId])).rows[0];
        if(!valid.valid)throw 404;
        if((await client.query('SELECT count(*)::int n FROM mas_business_runner_device WHERE owner_id=$1',[user.id])).rows[0].n>=100)throw 409;
        await client.query('UPDATE mas_business_runner_device SET owner_id=$2,pairing_until=NULL WHERE id=$1',[runnerId,user.id]);
      }
    }else{
      if(!device||device.owner_id!==user.id)throw 404;
      await client.query(`UPDATE mas_business_runner_device SET revoked_at=coalesce(revoked_at,clock_timestamp()),
        session_hash=NULL,session_until=NULL WHERE id=$1`,[runnerId]);
    }
    return {identityId:principal.id,device:await ownedDevice(client,user.id,runnerId)};
  });
}

export async function listDevices(pool:Pool,principal:IdentityPrincipal){
  return projectTransaction(pool,async client=>{
    const user=(await client.query('SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR SHARE',[principal.id])).rows[0];
    if(user&&user.status!=='active')throw 403;
    const result=await client.query(`SELECT id AS "runnerId",name,
      (revoked_at IS NULL AND session_until>clock_timestamp()) IS TRUE AS online,
      extract(epoch FROM last_seen)*1000 AS "lastSeen",revoked_at IS NOT NULL AS revoked,
      false AS "executionReady" FROM mas_business_runner_device WHERE owner_id=$1 ORDER BY created_at,id`,[user?.id??null]);
    return {identityId:principal.id,devices:result.rows.map(row=>({...row,lastSeen:row.lastSeen===null?null:Number(row.lastSeen)}))};
  });
}
