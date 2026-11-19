import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {listBoards,mutateBoard} from './boards.ts';

const collection=/^\/api\/account\/projects\/([^/]+)\/boards$/;
const mutation=/^\/api\/account\/projects\/([^/]+)\/boards\/([^/]+)\/(rename|archive)$/;
const uuid=z.uuid().transform(value=>value.toLowerCase());
const named=z.object({name:z.string().trim().min(1).max(120),requestId:uuid}).strict();
const receipt=z.object({requestId:uuid}).strict();

export function boardRoute(request:Request){
  const path=new URL(request.url).pathname;
  return (request.method==='GET'&&collection.test(path))||(request.method==='POST'&&(collection.test(path)||mutation.test(path)));
}

export async function handleBoardRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  const path=new URL(request.url).pathname;
  const list=collection.exec(path);
  if(list){
    const projectId=uuid.parse(list[1]);
    if(request.method==='GET')return listBoards(pool,principal.id,projectId);
    return mutateBoard(pool,principal.id,projectId,{kind:'create',...named.parse(await readBoundedJson(request))});
  }
  const match=mutation.exec(path);if(!match)throw 404;
  const projectId=uuid.parse(match[1]),boardId=uuid.parse(match[2]);
  if(match[3]==='rename')return mutateBoard(pool,principal.id,projectId,{kind:'rename',boardId,...named.parse(await readBoundedJson(request))});
  return mutateBoard(pool,principal.id,projectId,{kind:'archive',boardId,...receipt.parse(await readBoundedJson(request))});
}
