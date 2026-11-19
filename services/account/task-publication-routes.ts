import type {Pool} from 'pg';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {publicationInput,publicationUuid} from './task-publication-input.ts';
import {getTaskPublication,listTaskPublications,publishTasks} from './task-publications.ts';

const collection=/^\/api\/account\/projects\/([^/]+)\/stories\/([^/]+)\/publications$/;
const detail=/^\/api\/account\/projects\/([^/]+)\/publications\/([^/]+)$/;
export function publicationMutationPath(path:string){
  const match=collection.exec(path);
  return !!match&&match.slice(1).every(value=>publicationUuid.safeParse(value).success);
}
export function publicationRoute(request:Request){
  const path=new URL(request.url).pathname;
  return (request.method==='POST'&&collection.test(path))||
    (request.method==='GET'&&(collection.test(path)||detail.test(path)));
}
export async function handlePublicationRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  const path=new URL(request.url).pathname,match=collection.exec(path);
  if(match){
    const projectId=publicationUuid.parse(match[1]),storyId=publicationUuid.parse(match[2]);
    return request.method==='GET'?listTaskPublications(pool,principal.id,projectId,storyId):
      publishTasks(pool,principal.id,projectId,storyId,publicationInput.parse(await readBoundedJson(request,96*1024)));
  }
  const item=detail.exec(path);
  if(item&&request.method==='GET')return getTaskPublication(pool,principal.id,publicationUuid.parse(item[1]),publicationUuid.parse(item[2]));
  throw 404;
}
