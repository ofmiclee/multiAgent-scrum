import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool} from 'pg';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {authorizeProject,projectTransaction} from './project-scope.ts';
import {bindBodyImages} from './body-images.ts';

const pathPattern=/^\/api\/account\/projects\/([^/]+)\/boards\/([^/]+)\/tasks$/;
const inputSchema=z.object({body:z.string().trim().min(1).max(4000),requestId:z.uuid()}).strict();
export function directTaskMutationPath(path:string){const match=pathPattern.exec(path);return !!match&&match.slice(1).every(id=>z.uuid().safeParse(id).success);}
export function directTaskRoute(request:Request){return request.method==='POST'&&pathPattern.test(new URL(request.url).pathname);}
export async function handleDirectTaskRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  const match=pathPattern.exec(new URL(request.url).pathname)!,projectId=z.uuid().parse(match[1]),boardId=z.uuid().parse(match[2]);
  const input=inputSchema.parse(await readBoundedJson(request,96*1024));
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,principal.id,projectId,true);
    if(!(await client.query('SELECT id FROM mas_business_board WHERE id=$1 AND project_id=$2 AND archived_at IS NULL FOR SHARE',[boardId,projectId])).rowCount)throw 404;
    const hash=createHash('sha256').update(JSON.stringify({operation:'direct-task',projectId,boardId,body:input.body})).digest('hex');
    const previous=(await client.query(`SELECT p.request_hash,t.id FROM mas_business_task_publication p
      JOIN mas_business_task t ON t.publication_id=p.id WHERE p.author_id=$1 AND p.request_id=$2`,[user.id,input.requestId])).rows[0];
    if(previous){if(previous.request_hash!==hash)throw 409;return {taskId:previous.id as string};}
    await bindBodyImages(client,projectId,user.id,input.body);
    const publicationId=randomUUID(),taskId=randomUUID();
    await client.query(`INSERT INTO mas_business_task_publication(id,project_id,board_id,author_id,request_id,request_hash)
      VALUES($1,$2,$3,$4,$5,$6)`,[publicationId,projectId,boardId,user.id,input.requestId,hash]);
    await client.query(`INSERT INTO mas_business_task(id,publication_id,project_id,board_id,position,local_key,title,objective,acceptance_criteria,required_capabilities,priority,source)
      VALUES($1,$2,$3,$4,0,'direct','',$5,'由项目成员根据任务正文与图片核对交付成果，人工验收。',ARRAY[]::text[],'normal','direct')`,[taskId,publicationId,projectId,boardId,input.body]);
    return {taskId};
  });
}
