import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {authorizeProject,authorizeProjectContent,projectTransaction} from './project-scope.ts';
import {storyProposalSchema,storyAssistanceListSchema,type StoryProposal} from './story-assistance-input.ts';
import {readBoundedJson} from '../identity/request.ts';
import type {IdentityPrincipal} from '../identity/service.ts';

const createInput=z.object({expectedVersion:z.number().int().positive(),requestId:z.uuid()}).strict();
const editInput=z.object({expectedVersion:z.number().int().positive(),proposal:storyProposalSchema}).strict();
const path=/^\/api\/account\/projects\/([^/]+)\/stories\/([^/]+)\/assistance(?:\/([^/]+))?$/;
export function storyAssistanceRoute(request:Request){return ['GET','POST'].includes(request.method)&&path.test(new URL(request.url).pathname);}
export async function handleStoryAssistanceRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  const match=path.exec(new URL(request.url).pathname)!;const projectId=z.uuid().parse(match[1]),storyId=z.uuid().parse(match[2]);
  if(request.method==='GET'&&!match[3])return listStoryAssistance(pool,principal.id,projectId,storyId);
  if(request.method!=='POST')throw 404;
  const body=await readBoundedJson(request,96*1024);
  return match[3]?saveStoryDraft(pool,principal.id,projectId,storyId,z.uuid().parse(match[3]),editInput.parse(body)):
    requestStoryAssistance(pool,principal.id,projectId,storyId,createInput.parse(body));
}

export async function storyCoordinator(client:PoolClient,projectId:string){
  const result=(await client.query<{agent_id:string;owner_id:string;version:number;profile:'dsh-text'|'codex-code';model:string|null;instructions:string;runner_id:string;identity_id:string}>(`SELECT c.agent_id,c.owner_id,c.version,a.profile,a.model,a.instructions,a.runner_id,u.identity_id
    FROM mas_business_project p JOIN mas_business_project_coordinator c ON c.project_id=p.id AND c.owner_id=p.owner_id
    JOIN mas_business_agent a ON a.id=c.agent_id AND a.owner_id=p.owner_id
    JOIN mas_business_user u ON u.id=p.owner_id AND u.status='active'
    JOIN mas_business_runner_device d ON d.id=a.runner_id AND d.revoked_at IS NULL
    JOIN mas_business_agent_project g ON g.agent_id=a.id AND g.project_id=p.id AND g.enabled
    WHERE p.id=$1 AND NOT c.paused AND a.enabled AND a.profile IN ('dsh-text','codex-code') FOR SHARE OF c,a,g,d`,[projectId])).rows[0];
  if(!result)throw 409;
  await authorizeProject(client,result.identity_id,projectId,false);
  return result;
}

async function rows(client:PoolClient,projectId:string,storyId:string){
  const result=await client.query(`SELECT j.id,j.story_version AS "storyVersion",j.state,j.version,j.calls,j.proposal,j.issues,
    (s.current_version<>j.story_version) AS stale FROM mas_business_story_assistance j JOIN mas_business_story s ON s.id=j.story_id
    WHERE j.project_id=$1 AND j.story_id=$2 ORDER BY j.created_at DESC,j.id DESC LIMIT 10`,[projectId,storyId]);
  return storyAssistanceListSchema.parse({jobs:result.rows});
}
async function story(client:PoolClient,projectId:string,storyId:string,write=false){
  const row=(await client.query<{current_version:number}>(`SELECT current_version FROM mas_business_story WHERE project_id=$1 AND id=$2 FOR ${write?'UPDATE':'SHARE'}`,[projectId,storyId])).rows[0];
  if(!row)throw 404;return row;
}
export async function listStoryAssistance(pool:Pool,identityId:string,projectId:string,storyId:string){
  return projectTransaction(pool,async client=>{await authorizeProjectContent(client,identityId,projectId);await story(client,projectId,storyId);return rows(client,projectId,storyId);});
}
export async function requestStoryAssistance(pool:Pool,identityId:string,projectId:string,storyId:string,raw:z.infer<typeof createInput>){
  const input=createInput.parse(raw);
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,identityId,projectId,true),source=await story(client,projectId,storyId,true);
    const previous=(await client.query<{id:string;story_id:string;story_version:number;project_id:string}>('SELECT id,story_id,story_version,project_id FROM mas_business_story_assistance WHERE requester_id=$1 AND request_id=$2',[user.id,input.requestId])).rows[0];
    if(previous){if(previous.story_id!==storyId||previous.project_id!==projectId||previous.story_version!==input.expectedVersion)throw 409;return {jobId:previous.id};}
    if(source.current_version!==input.expectedVersion)throw 409;
    await storyCoordinator(client,projectId);
    if((await client.query("SELECT 1 FROM mas_business_story_assistance WHERE story_id=$1 AND state IN ('queued','running')",[storyId])).rowCount)throw 409;
    const id=randomUUID();
    await client.query('INSERT INTO mas_business_story_assistance(id,project_id,story_id,story_version,requester_id,request_id) VALUES($1,$2,$3,$4,$5,$6)',[id,projectId,storyId,input.expectedVersion,user.id,input.requestId]);
    return {jobId:id};
  });
}
export async function saveStoryDraft(pool:Pool,identityId:string,projectId:string,storyId:string,jobId:string,raw:{expectedVersion:number;proposal:StoryProposal}){
  const input=editInput.parse(raw);
  return projectTransaction(pool,async client=>{
    await authorizeProject(client,identityId,projectId,true);const source=await story(client,projectId,storyId,true);
    const job=(await client.query<{version:number;story_version:number;state:string;proposal:StoryProposal}>('SELECT version,story_version,state,proposal FROM mas_business_story_assistance WHERE id=$1 AND project_id=$2 AND story_id=$3 FOR UPDATE',[jobId,projectId,storyId])).rows[0];
    if(!job)throw 404;if(job.state!=='draft'||job.story_version!==source.current_version)throw 409;
    if(job.version!==input.expectedVersion){if(job.version!==input.expectedVersion+1||!isDeepStrictEqual(job.proposal,input.proposal))throw 409;return {version:job.version};}
    await client.query('UPDATE mas_business_story_assistance SET proposal=$2,version=version+1 WHERE id=$1',[jobId,input.proposal]);
    return {version:job.version+1};
  });
}
