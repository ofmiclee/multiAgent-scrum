import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {authorizeProject,authorizeProjectContent,projectTransaction} from './project-scope.ts';
import type {PublicationInput} from './task-publication-input.ts';

async function detail(client:PoolClient,projectId:string,id:string){
  const publication=(await client.query(`SELECT p.id,p.project_id AS "projectId",p.board_id AS "boardId",
    p.story_id AS "storyId",p.story_version AS "storyVersion",p.author_id AS "authorId",
    jsonb_build_object('title',r.title,'body',r.body,'version',r.version) AS "sourceStory"
    FROM mas_business_task_publication p
    JOIN mas_business_story_revision r ON r.story_id=p.story_id AND r.version=p.story_version
    WHERE p.project_id=$1 AND p.id=$2`,[projectId,id])).rows[0];
  if(!publication)throw 404;
  const tasks=await client.query(`SELECT t.id,t.local_key AS key,t.title,t.objective,
    t.acceptance_criteria AS "acceptanceCriteria",t.required_capabilities AS "requiredCapabilities",
    t.priority,t.status,COALESCE((SELECT jsonb_agg(d.depends_on_id ORDER BY parent.position)
      FROM mas_business_task_dependency d JOIN mas_business_task parent ON parent.id=d.depends_on_id
      WHERE d.task_id=t.id),'[]'::jsonb) AS "dependsOn"
    FROM mas_business_task t WHERE t.publication_id=$1 ORDER BY t.position`,[id]);
  return {publication:{...publication,tasks:tasks.rows}};
}

export async function publishTasks(pool:Pool,identityId:string,projectId:string,storyId:string,input:PublicationInput){
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,identityId,projectId,true);
    const story=(await client.query<{board_id:string;current_version:number}>(`SELECT board_id,current_version
      FROM mas_business_story WHERE project_id=$1 AND id=$2 FOR UPDATE`,[projectId,storyId])).rows[0];
    if(!story)throw 404;
    const hash=createHash('sha256').update(JSON.stringify({projectId,storyId,expectedVersion:input.expectedVersion,tasks:input.tasks})).digest('hex');
    const previous=(await client.query<{id:string;request_hash:string}>(`SELECT id,request_hash
      FROM mas_business_task_publication WHERE author_id=$1 AND request_id=$2`,[user.id,input.requestId])).rows[0];
    if(previous){if(previous.request_hash!==hash)throw 409;return detail(client,projectId,previous.id);}
    if(story.current_version!==input.expectedVersion)throw 409;
    if((await client.query('SELECT 1 FROM mas_business_task_publication WHERE story_id=$1 AND story_version=$2',
      [storyId,input.expectedVersion])).rowCount)throw 409;
    const id=randomUUID();
    await client.query(`INSERT INTO mas_business_task_publication
      (id,project_id,board_id,story_id,story_version,author_id,request_id,request_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,[id,projectId,story.board_id,storyId,input.expectedVersion,user.id,input.requestId,hash]);
    const taskIds=new Map(input.tasks.map(task=>[task.key,randomUUID()]));
    for(const [position,task] of input.tasks.entries()){
      await client.query(`INSERT INTO mas_business_task
        (id,publication_id,project_id,board_id,position,local_key,title,objective,acceptance_criteria,required_capabilities,priority)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[taskIds.get(task.key),id,projectId,story.board_id,position,
        task.key,task.title,task.objective,task.acceptanceCriteria,task.requiredCapabilities,task.priority]);
    }
    for(const task of input.tasks)for(const dependency of task.dependsOn){
      await client.query('INSERT INTO mas_business_task_dependency(publication_id,task_id,depends_on_id) VALUES ($1,$2,$3)',
        [id,taskIds.get(task.key),taskIds.get(dependency)]);
    }
    return detail(client,projectId,id);
  });
}

export async function getTaskPublication(pool:Pool,identityId:string,projectId:string,id:string){
  return projectTransaction(pool,async client=>{
    await authorizeProjectContent(client,identityId,projectId);return detail(client,projectId,id);
  });
}

export async function listTaskPublications(pool:Pool,identityId:string,projectId:string,storyId:string){
  return projectTransaction(pool,async client=>{
    await authorizeProjectContent(client,identityId,projectId);
    if(!(await client.query('SELECT 1 FROM mas_business_story WHERE id=$1 AND project_id=$2',[storyId,projectId])).rowCount)throw 404;
    const results=await client.query(`SELECT p.id,p.story_version AS "storyVersion",p.author_id AS "authorId",
      (SELECT count(*)::int FROM mas_business_task t WHERE t.publication_id=p.id) AS "taskCount"
      FROM mas_business_task_publication p WHERE p.project_id=$1 AND p.story_id=$2
      ORDER BY p.created_at DESC,p.id DESC LIMIT 51`,[projectId,storyId]);
    return {publications:results.rows.slice(0,50),hasMore:results.rows.length>50};
  });
}
