import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {authorizeProject,authorizeProjectContent,projectTransaction} from './project-scope.ts';
import {bindBodyImages} from './body-images.ts';

const pathPattern=/^\/api\/account\/projects\/([^/]+)\/tasks\/([^/]+)\/rework$/;
const inputSchema=z.object({identityId:z.string().min(1).max(128),requestId:z.uuid(),expectedRevision:z.number().int().min(1).max(4),title:z.string().trim().max(200),objective:z.string().trim().min(1).max(4000),acceptanceCriteria:z.string().trim().min(1).max(4000),requiredCapability:z.enum(['coding','writing']),reason:z.string().trim().min(1).max(500)}).strict();
// This content endpoint also serves organization observers. Strip private and
// transport fields at every JSON boundary; stored execution evidence stays intact.
const businessResult=z.object({summary:z.string().optional(),artifacts:z.array(z.object({name:z.string(),content:z.string()})).optional(),checksPassed:z.boolean().optional(),
  difficulty:z.number().optional(),risk:z.string().optional(),confidence:z.number().optional(),rationale:z.string().optional(),requiredCapability:z.string().optional()}).nullable();
const businessWork=z.array(z.object({id:z.string(),task_id:z.string(),kind:z.string(),state:z.string(),calls:z.number(),round_start_calls:z.number().optional(),
  result:businessResult,approved:z.boolean(),issues:z.array(z.string()),created_at:z.string(),deadline_at:z.string().nullable()}));
export function taskReworkRoute(request:Request){return ['GET','POST'].includes(request.method)&&pathPattern.test(new URL(request.url).pathname);}
export async function handleTaskRework(pool:Pool,principal:IdentityPrincipal,request:Request){
  if(!taskReworkRoute(request))throw 404;
  const path=pathPattern.exec(new URL(request.url).pathname)!,projectId=z.uuid().parse(path[1]),taskId=z.uuid().parse(path[2]);
  const input=request.method==='POST'?inputSchema.parse(await readBoundedJson(request,32768)):null;
  if(input&&input.identityId!==principal.id)throw 403;
  return projectTransaction(pool,async client=>{
    const user=input?await authorizeProject(client,principal.id,projectId,true):await authorizeProjectContent(client,principal.id,projectId);
    const owner=(await client.query<{owner_id:string}>('SELECT owner_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0];
    if(input&&owner.owner_id!==user.id)throw 403;
    const work=(await client.query(`SELECT * FROM mas_business_work WHERE task_id=$1 ORDER BY id ${input?'FOR UPDATE':''}`,[taskId])).rows;
    const task=(await client.query(`SELECT * FROM mas_business_task WHERE id=$1 AND project_id=$2 ${input?'FOR UPDATE':''}`,[taskId,projectId])).rows[0];if(!task)throw 404;
    const unsettled=Boolean((await client.query(`SELECT 1 FROM mas_business_work_attempt a JOIN mas_business_work w ON w.id=a.work_id
      WHERE w.task_id=$1 AND a.state IN ('assigned','running') LIMIT 1`,[taskId])).rowCount);
    const failed=task.status==='failed'||work.some(w=>w.kind==='assess'&&w.state==='failed');
    const canRework=failed&&!unsettled&&task.input_revision<4&&!['running','assigned','review','done'].includes(task.status);
    if(!input){
      const history=(await client.query(`SELECT revision,reason,previous,work,created_at AS "createdAt" FROM mas_business_task_rework WHERE task_id=$1 ORDER BY revision DESC`,[taskId])).rows;
      const attempts=(await client.query(`SELECT a.id,a.fence,a.state,a.report,a.finished_at AS "finishedAt",w.kind,
        r.decision,r.feedback FROM mas_business_work_attempt a JOIN mas_business_work w ON w.id=a.work_id
        LEFT JOIN mas_business_work_review r ON r.attempt_id=a.id WHERE w.task_id=$1 ORDER BY a.created_at,a.id`,[taskId])).rows;
      return {identityId:principal.id,taskId,revision:task.input_revision,current:{title:task.title,objective:task.objective,acceptanceCriteria:task.acceptance_criteria,requiredCapabilities:task.required_capabilities},canRework:canRework&&owner.owner_id===user.id&&user.projectRole==='owner',unsettled,
        history:history.map(item=>({...item,work:businessWork.parse(item.work)})),attempts:attempts.map(item=>({...item,report:businessResult.parse(item.report)}))};
    }
    const hash=createHash('sha256').update(JSON.stringify({projectId,taskId,...input})).digest('hex');
    const receipt=(await client.query('SELECT task_id,request_hash FROM mas_business_task_rework WHERE actor_id=$1 AND request_id=$2',[user.id,input.requestId])).rows[0];
    if(receipt){if(receipt.task_id!==taskId||receipt.request_hash!==hash)throw 409;return {identityId:principal.id,ok:true as const};}
    if(input.expectedRevision!==task.input_revision||!canRework)throw 409;
    if(task.title===''?input.title!=='':!input.title)throw 400;
    await bindBodyImages(client,projectId,user.id,input.objective);
    const previous={title:task.title,objective:task.objective,acceptanceCriteria:task.acceptance_criteria,requiredCapabilities:task.required_capabilities,status:task.status};
    await client.query('INSERT INTO mas_business_task_rework(task_id,revision,actor_id,request_id,request_hash,reason,previous,work) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[taskId,task.input_revision,user.id,input.requestId,hash,input.reason,previous,JSON.stringify(work)]);
    await client.query("UPDATE mas_business_task SET title=$2,objective=$3,acceptance_criteria=$4,required_capabilities=$5,status='pending',input_revision=input_revision+1 WHERE id=$1",[taskId,input.title,input.objective,input.acceptanceCriteria,[input.requiredCapability]]);
    await client.query("UPDATE mas_business_work SET state='queued',round_start_calls=calls,result=NULL,approved=false,issues='[]'::jsonb,deadline_at=NULL WHERE task_id=$1",[taskId]);
    return {identityId:principal.id,ok:true as const};
  });
}
