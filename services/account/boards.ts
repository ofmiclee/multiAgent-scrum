import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {authorizeProject,authorizeProjectContent,projectTransaction} from './project-scope.ts';
import type {Pool} from 'pg';

export type BoardMutation={kind:'create';name:string;requestId:string}
  |{kind:'rename';boardId:string;name:string;requestId:string}
  |{kind:'archive';boardId:string;requestId:string};

type BoardRow={id:string;name:string;isDefault:boolean;archived:boolean};
const projection=`b.id,b.name,(b.id=p.default_board_id) AS "isDefault",(b.archived_at IS NOT NULL) AS archived`;

async function projectBoards(client:PoolClient,projectId:string,activeOnly=true){
  const result=await client.query<BoardRow>(`SELECT ${projection} FROM mas_business_board b
    JOIN mas_business_project p ON p.id=b.project_id
    WHERE b.project_id=$1 ${activeOnly?'AND b.archived_at IS NULL':''}
    ORDER BY b.created_at,b.id`,[projectId]);
  return result.rows;
}

export async function listBoards(pool:Pool,identityId:string,projectId:string){
  return projectTransaction(pool,async client=>{
    await authorizeProjectContent(client,identityId,projectId);
    const project=(await client.query<{defaultBoardId:string}>('SELECT default_board_id AS "defaultBoardId" FROM mas_business_project WHERE id=$1',[projectId])).rows[0];
    return {projectId,defaultBoardId:project.defaultBoardId,boards:await projectBoards(client,projectId)};
  });
}

export async function mutateBoard(pool:Pool,identityId:string,projectId:string,command:BoardMutation){
  return projectTransaction(pool,async client=>{
    const user=await authorizeProject(client,identityId,projectId,true);
    const membership=(await client.query<{role:string}>(`SELECT role FROM mas_business_project_member
      WHERE project_id=$1 AND user_id=$2 AND status='active' FOR SHARE`,[projectId,user.id])).rows[0];
    if(!['owner','manager'].includes(membership?.role??''))throw 403;
    const hash=createHash('sha256').update(JSON.stringify({kind:command.kind,projectId,...('boardId'in command?{boardId:command.boardId}:{}),...('name'in command?{name:command.name}:{})})).digest('hex');
    const previous=(await client.query<{request_hash:string;board_id:string;result_name:string;result_archived:boolean}>(`SELECT request_hash,board_id,result_name,result_archived
      FROM mas_business_board_command WHERE user_id=$1 AND request_id=$2`,[user.id,command.requestId])).rows[0];
    if(previous){
      if(previous.request_hash!==hash)throw 409;
      const defaultBoardId=(await client.query<{default_board_id:string}>('SELECT default_board_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0].default_board_id;
      return {board:{id:previous.board_id,name:previous.result_name,isDefault:previous.board_id===defaultBoardId,archived:previous.result_archived}};
    }
    let board:BoardRow;
    if(command.kind==='create'){
      // Project creation already creates its only Scrum board. Historical
      // boards/receipts remain readable; no new extra boards are accepted.
      throw 409;
    }else{
      const current=(await client.query<BoardRow>(`SELECT ${projection} FROM mas_business_board b
        JOIN mas_business_project p ON p.id=b.project_id WHERE b.project_id=$1 AND b.id=$2 FOR UPDATE OF b`,[projectId,command.boardId])).rows[0];
      if(!current)throw 404;
      if(command.kind==='rename'){
        if(current.archived)throw 409;
        await client.query('UPDATE mas_business_board SET name=$1 WHERE project_id=$2 AND id=$3',[command.name,projectId,command.boardId]);
        board={...current,name:command.name};
      }else{
        if(current.isDefault||current.archived)throw 409;
        const active=(await client.query<{count:number}>('SELECT count(*)::int AS count FROM mas_business_board WHERE project_id=$1 AND archived_at IS NULL',[projectId])).rows[0].count;
        if(active<=1)throw 409;
        await client.query('UPDATE mas_business_board SET archived_at=now() WHERE project_id=$1 AND id=$2',[projectId,command.boardId]);
        board={...current,archived:true};
      }
    }
    await client.query(`INSERT INTO mas_business_board_command(user_id,request_id,request_hash,kind,project_id,board_id,result_name,result_archived)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[user.id,command.requestId,hash,command.kind,projectId,board.id,board.name,board.archived]);
    return {board};
  });
}
