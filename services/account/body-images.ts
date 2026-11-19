import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {authorizeProject,authorizeProjectContent,projectTransaction} from './project-scope.ts';
import {bodyImageReferences,bodyImageUrl} from '../../packages/domain/body-images.ts';

export const bodyImageUploadLimit=14*1024*1024;
const pathPattern=/^\/api\/account\/projects\/([^/]+)\/body-images(?:\/([^/]+))?$/;
const inputSchema=z.object({id:z.uuid(),data:z.string().min(1).max(13981016).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict();
export function bodyImageUploadPath(path:string){const match=pathPattern.exec(path);return !!match&&!match[2]&&z.uuid().safeParse(match[1]).success;}
export function bodyImageRoute(request:Request){const match=pathPattern.exec(new URL(request.url).pathname);return !!match&&(request.method==='POST'&&!match[2]||request.method==='GET'&&!!match[2]);}

export async function bindBodyImages(client:PoolClient,projectId:string,userId:string,body:string){
  const refs=bodyImageReferences(body);
  if(refs.length>8||refs.some(ref=>ref.projectId!==projectId))throw 400;
  for(const ref of refs){
    const row=(await client.query(`UPDATE mas_business_body_image SET committed=true WHERE id=$1 AND project_id=$2
      AND (committed OR (author_id=$3 AND created_at>now()-interval '24 hours')) RETURNING id`,[ref.id,projectId,userId])).rows[0];
    if(!row)throw 400;
  }
}

export async function handleBodyImageRequest(pool:Pool,principal:IdentityPrincipal,request:Request):Promise<Response>{
  const match=pathPattern.exec(new URL(request.url).pathname)!;
  const projectId=z.uuid().parse(match[1]);
  if(request.method==='GET'){
    const id=z.uuid().parse(match[2]);
    const bytes=await projectTransaction(pool,async client=>{
      const user=await authorizeProjectContent(client,principal.id,projectId);
      const row=(await client.query<{bytes:Buffer}>(`SELECT bytes FROM mas_business_body_image WHERE id=$1 AND project_id=$2
        AND (committed OR (author_id=$3 AND created_at>now()-interval '24 hours'))`,[id,projectId,user.id])).rows[0];
      if(!row)throw 404;return row.bytes;
    });
    return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'image/webp','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'}});
  }
  const input=inputSchema.parse(await readBoundedJson(request,bodyImageUploadLimit));
  const result=await projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,principal.id,projectId,true);
    const original=Buffer.from(input.data,'base64');
    if(original.length>10*1024*1024||original.toString('base64')!==input.data)throw 413;
    const hash=createHash('sha256').update(original).digest('hex');
    const previous=(await client.query('SELECT project_id,author_id,request_hash FROM mas_business_body_image WHERE id=$1',[input.id])).rows[0];
    if(previous){if(previous.project_id!==projectId||previous.author_id!==user.id||previous.request_hash!==hash)throw 409;return {url:bodyImageUrl(projectId,input.id)};}
    let bytes:Buffer;
    try{
      const raster=original.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||
        original[0]===255&&original[1]===216&&original[2]===255||
        original.toString('ascii',0,4)==='RIFF'&&original.toString('ascii',8,12)==='WEBP';
      if(!raster)throw Error('Unsupported image');
      const decoder=sharp(original,{limitInputPixels:16_000_000,failOn:'warning',animated:false});
      const info=await decoder.metadata();
      if(!['png','jpeg','webp'].includes(info.format??'')||(info.pages??1)>1)throw Error('Unsupported image');
      bytes=await decoder.rotate().webp({quality:85}).toBuffer();
    }catch{throw 400;}
    if(bytes.length>10*1024*1024)throw 413;
    // Serialize quota accounting across different project members.
    await client.query('SELECT id FROM mas_business_project WHERE id=$1 FOR UPDATE',[projectId]);
    await client.query("DELETE FROM mas_business_body_image WHERE project_id=$1 AND NOT committed AND created_at<now()-interval '24 hours'",[projectId]);
    const usage=(await client.query(`SELECT coalesce(sum(octet_length(bytes)),0)::bigint AS total,
      coalesce(sum(octet_length(bytes)) FILTER (WHERE author_id=$2 AND NOT committed),0)::bigint AS draft,
      count(*) FILTER (WHERE author_id=$2 AND NOT committed)::integer AS drafts
      FROM mas_business_body_image WHERE project_id=$1`,[projectId,user.id])).rows[0];
    if(Number(usage.total)+bytes.length>256*1024*1024||Number(usage.draft)+bytes.length>80*1024*1024||usage.drafts>=32)throw 429;
    await client.query('INSERT INTO mas_business_body_image(id,project_id,author_id,request_hash,bytes) VALUES($1,$2,$3,$4,$5)',[input.id,projectId,user.id,hash,bytes]);
    return {url:bodyImageUrl(projectId,input.id)};
  });
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
}
