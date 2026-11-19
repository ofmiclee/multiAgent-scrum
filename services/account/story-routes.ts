import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {createStory,editStory,getStory,listStories,listStoryRevisions} from './stories.ts';

const collectionPath=/^\/api\/account\/projects\/([^/]+)\/boards\/([^/]+)\/stories$/;
const detailPath=/^\/api\/account\/projects\/([^/]+)\/stories\/([^/]+)$/;
const historyPath=/^\/api\/account\/projects\/([^/]+)\/stories\/([^/]+)\/revisions$/;
const uuid=z.uuid().transform(value=>value.toLowerCase());
const createSchema=z.object({
  title:z.string().trim().min(1).max(200),body:z.string().min(1).max(12000).refine(value=>!!value.trim()),requestId:uuid,
}).strict();
const editSchema=createSchema.extend({expectedVersion:z.number().int().min(1)}).strict();

/** Shared by the account HTTP intake boundary so only real, exact story
 * mutation paths receive the larger body allowance. UUID hex is case-insensitive;
 * every route literal remains case-sensitive. */
export function storyMutationPath(path:string):boolean{
  const match=collectionPath.exec(path)??detailPath.exec(path);
  return !!match&&match.slice(1).every(value=>uuid.safeParse(value).success);
}

export function storyRoute(request:Request):boolean{
  const path=new URL(request.url).pathname;
  if(request.method==='POST')return collectionPath.test(path)||detailPath.test(path);
  return request.method==='GET'&&(collectionPath.test(path)||detailPath.test(path)||historyPath.test(path));
}

export async function handleStoryRequest(pool:Pool,principal:IdentityPrincipal,request:Request):Promise<unknown>{
  const path=new URL(request.url).pathname;
  let match=collectionPath.exec(path);
  if(match){
    const projectId=uuid.parse(match[1]),boardId=uuid.parse(match[2]);
    return request.method==='GET'?listStories(pool,principal.id,projectId,boardId):
      createStory(pool,principal.id,projectId,boardId,createSchema.parse(await readBoundedJson(request,96*1024)));
  }
  match=historyPath.exec(path);
  if(match&&request.method==='GET')return listStoryRevisions(pool,principal.id,uuid.parse(match[1]),uuid.parse(match[2]));
  match=detailPath.exec(path);
  if(match){
    const projectId=uuid.parse(match[1]),storyId=uuid.parse(match[2]);
    return request.method==='GET'?getStory(pool,principal.id,projectId,storyId):
      editStory(pool,principal.id,projectId,storyId,editSchema.parse(await readBoundedJson(request,96*1024)));
  }
  throw 404;
}
