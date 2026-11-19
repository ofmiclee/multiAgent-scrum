import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {authorizeProject as authorize,authorizeProjectContent,projectTransaction as transaction} from './project-scope.ts';
import {bindBodyImages} from './body-images.ts';

export type StoryInput={title:string;body:string;requestId:string};
export type StoryEditInput=StoryInput&{expectedVersion:number};
export type Story={id:string;projectId:string;boardId:string;title:string;body:string;version:number;authorId:string};

const projection=`s.id,s.project_id AS "projectId",s.board_id AS "boardId",
  r.title,r.body,r.version,r.author_id AS "authorId",(to_jsonb(s)->>'number')::integer AS number,
  (SELECT (to_jsonb(p)->>'key')||'-'||(to_jsonb(s)->>'number') FROM mas_business_project p WHERE p.id=s.project_id) AS reference`;

async function revision(client:PoolClient,storyId:string,version:number){
  return (await client.query<Story>(`SELECT ${projection} FROM mas_business_story s
    JOIN mas_business_story_revision r ON r.story_id=s.id AND r.version=$2
    WHERE s.id=$1`,[storyId,version])).rows[0];
}

async function checkedStory(client:PoolClient,projectId:string,storyId:string,lock=false){
  const story=(await client.query<{id:string;board_id:string;current_version:number}>(`SELECT id,board_id,current_version
    FROM mas_business_story WHERE id=$1 AND project_id=$2${lock?' FOR UPDATE':''}`,[storyId,projectId])).rows[0];
  if(!story)throw 404;return story;
}

export async function createStory(pool:Pool,identityId:string,projectId:string,boardId:string,input:StoryInput){
  return transaction(pool,async client=>{
    const user=await authorize(client,identityId,projectId,true);
    if(!(await client.query('SELECT 1 FROM mas_business_board WHERE project_id=$1 AND id=$2',[projectId,boardId])).rowCount)throw 404;
    const hash=createHash('sha256').update(JSON.stringify({operation:'create',projectId,boardId,title:input.title,body:input.body})).digest('hex');
    const previous=(await client.query<{request_hash:string;story_id:string;story_version:number}>(`SELECT request_hash,story_id,story_version
      FROM mas_business_story_command WHERE user_id=$1 AND request_id=$2`,[user.id,input.requestId])).rows[0];
    if(previous){if(previous.request_hash!==hash)throw 409;return {story:await revision(client,previous.story_id,previous.story_version)};}
    await bindBodyImages(client,projectId,user.id,input.body);
    const storyId=randomUUID();
    const numbered=(await client.query("SELECT to_jsonb(p) ? 'next_story_number' AS enabled FROM mas_business_project p WHERE id=$1",[projectId])).rows[0].enabled;
    if(numbered){
      const allocation=(await client.query('UPDATE mas_business_project SET next_story_number=next_story_number+1 WHERE id=$1 RETURNING next_story_number-1 AS number',[projectId])).rows[0];
      await client.query('INSERT INTO mas_business_story(id,project_id,board_id,number) VALUES ($1,$2,$3,$4)',[storyId,projectId,boardId,allocation.number]);
    }else await client.query('INSERT INTO mas_business_story(id,project_id,board_id) VALUES ($1,$2,$3)',[storyId,projectId,boardId]);
    await client.query(`INSERT INTO mas_business_story_revision(story_id,project_id,board_id,version,title,body,author_id)
      VALUES ($1,$2,$3,1,$4,$5,$6)`,[storyId,projectId,boardId,input.title,input.body,user.id]);
    await client.query(`INSERT INTO mas_business_story_command(user_id,request_id,request_hash,story_id,story_version)
      VALUES ($1,$2,$3,$4,1)`,[user.id,input.requestId,hash,storyId]);
    return {story:await revision(client,storyId,1)};
  });
}

export async function listStories(pool:Pool,identityId:string,projectId:string,boardId:string){
  return transaction(pool,async client=>{
    await authorizeProjectContent(client,identityId,projectId);
    if(!(await client.query('SELECT 1 FROM mas_business_board WHERE project_id=$1 AND id=$2',[projectId,boardId])).rowCount)throw 404;
    const stories=await client.query<Story>(`SELECT ${projection} FROM mas_business_story s
      JOIN mas_business_story_revision r ON r.story_id=s.id AND r.version=s.current_version
      WHERE s.project_id=$1 AND s.board_id=$2 ORDER BY s.created_at,s.id`,[projectId,boardId]);
    return {stories:stories.rows};
  });
}

export async function getStory(pool:Pool,identityId:string,projectId:string,storyId:string){
  return transaction(pool,async client=>{
    await authorizeProjectContent(client,identityId,projectId);
    const current=await checkedStory(client,projectId,storyId);
    return {story:await revision(client,storyId,current.current_version)};
  });
}

export async function listStoryRevisions(pool:Pool,identityId:string,projectId:string,storyId:string){
  return transaction(pool,async client=>{
    await authorizeProjectContent(client,identityId,projectId);await checkedStory(client,projectId,storyId);
    const revisions=await client.query<{title:string;body:string;version:number;authorId:string}>(`SELECT title,body,version,
      author_id AS "authorId" FROM mas_business_story_revision WHERE story_id=$1 ORDER BY version`,[storyId]);
    return {revisions:revisions.rows};
  });
}

export async function editStory(pool:Pool,identityId:string,projectId:string,storyId:string,input:StoryEditInput){
  return transaction(pool,async client=>{
    const user=await authorize(client,identityId,projectId,true);
    const current=await checkedStory(client,projectId,storyId,true);
    const hash=createHash('sha256').update(JSON.stringify({operation:'edit',projectId,storyId,title:input.title,
      body:input.body,expectedVersion:input.expectedVersion})).digest('hex');
    const previous=(await client.query<{request_hash:string;story_id:string;story_version:number}>(`SELECT request_hash,story_id,story_version
      FROM mas_business_story_command WHERE user_id=$1 AND request_id=$2`,[user.id,input.requestId])).rows[0];
    if(previous){if(previous.request_hash!==hash)throw 409;return {story:await revision(client,previous.story_id,previous.story_version)};}
    if(current.current_version!==input.expectedVersion)throw 409;
    await bindBodyImages(client,projectId,user.id,input.body);
    const version=current.current_version+1;
    await client.query(`INSERT INTO mas_business_story_revision(story_id,project_id,board_id,version,title,body,author_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,[storyId,projectId,current.board_id,version,input.title,input.body,user.id]);
    await client.query('UPDATE mas_business_story SET current_version=$2 WHERE id=$1',[storyId,version]);
    await client.query(`INSERT INTO mas_business_story_command(user_id,request_id,request_hash,story_id,story_version)
      VALUES ($1,$2,$3,$4,$5)`,[user.id,input.requestId,hash,storyId,version]);
    return {story:await revision(client,storyId,version)};
  });
}
