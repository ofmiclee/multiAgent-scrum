import type {Pool} from 'pg';
import sharp from 'sharp';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readPersonalProfile} from '../identity/profile.ts';
import {readBoundedJson} from '../identity/request.ts';
import {projectTransaction} from './project-scope.ts';

export const profileUploadLimit=14*1024*1024;
const inputSchema=z.object({name:z.string().trim().min(1).max(120),signature:z.string().trim().max(200),
  version:z.number().int().min(0).max(2147483646),avatar:z.string().min(1).max(13981016).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional()}).strict();
export function profileRoute(request:Request){
  const path=new URL(request.url).pathname;
  return path==='/api/account/profile'&&['GET','POST'].includes(request.method)||request.method==='GET'&&/^\/api\/account\/profile\/avatar\/[1-9][0-9]{0,9}$/.test(path);
}
export async function decodeAvatar(data:string){
  const bytes=Buffer.from(data,'base64');
  if(bytes.length>10*1024*1024||bytes.toString('base64')!==data)throw 413;
  try{
    const raster=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes[0]===255&&bytes[1]===216&&bytes[2]===255||bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
    if(!raster)throw 400;
    const decoder=sharp(bytes,{limitInputPixels:16_000_000,failOn:'warning',animated:false});
    const info=await decoder.metadata();
    if(!['png','jpeg','webp'].includes(info.format??'')||(info.pages??1)>1)throw 400;
    return await decoder.rotate().resize(256,256,{fit:'cover'}).webp({quality:85}).toBuffer();
  }catch{throw 400;}
}
export async function handleProfileRequest(pool:Pool,principal:IdentityPrincipal,request:Request):Promise<Response>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-MAS-Identity':principal.id};
  const input=request.method==='POST'?inputSchema.parse(await readBoundedJson(request,profileUploadLimit)):null;
  return projectTransaction(pool,async client=>{
    // Identity lock serializes first profile creation as well as later edits.
    if(!(await client.query('SELECT id FROM mas_identity_user WHERE id=$1 FOR '+(input?'NO KEY UPDATE':'SHARE'),[principal.id])).rows[0])throw 403;
    const business=(await client.query('SELECT status FROM mas_business_user WHERE identity_id=$1 FOR SHARE',[principal.id])).rows[0];
    if(business&&business.status!=='active')throw 403;
    const current=await readPersonalProfile(client,principal.id);
    if(!current)throw 403;
    if(input){
      if(current.version!==input.version)throw 409;
      const avatar=input.avatar?await decodeAvatar(input.avatar):null;
      await client.query(`INSERT INTO mas_identity_profile(identity_id,name,signature,avatar) VALUES($1,$2,$3,$4)
        ON CONFLICT(identity_id) DO UPDATE SET name=excluded.name,signature=excluded.signature,
        avatar=coalesce(excluded.avatar,mas_identity_profile.avatar),version=mas_identity_profile.version+1,updated_at=now()`,[principal.id,input.name,input.signature,avatar]);
      await client.query('UPDATE mas_business_user SET name=$2 WHERE identity_id=$1',[principal.id,input.name]);
      return Response.json({user:await readPersonalProfile(client,principal.id)},{headers});
    }
    const path=new URL(request.url).pathname;
    if(path!=='/api/account/profile'){
      if(path!==current.image)throw 404;
      const row=(await client.query('SELECT avatar FROM mas_identity_profile WHERE identity_id=$1',[principal.id])).rows[0];
      if(!row?.avatar)throw 404;
      return new Response(new Uint8Array(row.avatar),{headers:{...headers,'Content-Type':'image/webp','Cross-Origin-Resource-Policy':'same-origin'}});
    }
    return Response.json({user:current},{headers});
  });
}
