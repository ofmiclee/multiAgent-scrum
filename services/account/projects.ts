import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

export type ProjectCommand = {kind:'list';organizationId:string}
  |{kind:'create';organizationId:string;name:string;requestId:string;key?:string;description?:string}
  |{kind:'detail';projectId:string};
type Project={id:string;organizationId:string;name:string;role:string;defaultBoardId:string};
const projection=`p.id,p.organization_id AS "organizationId",p.name,to_jsonb(p)->>'key' AS key,to_jsonb(p)->>'description' AS description,
  coalesce((to_jsonb(p)->>'version')::integer,1) AS version,CASE WHEN m.status='active' THEN m.role ELSE 'viewer' END AS role,p.default_board_id AS "defaultBoardId"`;

async function detail(client:PoolClient,userId:string,projectId:string,observer=false){
  // Lock membership until commit, including receipt replay. A stale receipt
  // never substitutes for current membership or waits out a revocation unchecked.
  const result=await client.query<Project>(`SELECT ${projection} FROM mas_business_project p
    LEFT JOIN mas_business_project_member m ON m.project_id=p.id AND m.user_id=$2
    WHERE p.id=$1 AND (m.status='active' OR $3)`,[projectId,userId,observer]);
  const project=result.rows[0];if(!project)throw 404;
  const boards=await client.query<{id:string;name:string;isDefault:boolean}>(`SELECT b.id,b.name,(b.id=$2) AS "isDefault"
    FROM mas_business_board b WHERE b.project_id=$1 AND (to_jsonb(b)->>'archived_at') IS NULL ORDER BY b.created_at,b.id`,[projectId,project.defaultBoardId]);
  return {project,boards:boards.rows};
}

/** Store for authenticated business projects, never the seeded preview aggregate.
 * All entry paths acquire locks user -> organization membership -> project membership. */
export async function handleProjectCommand(pool:Pool,identityId:string,command:ProjectCommand){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const user=(await client.query<{id:string;status:string}>(`SELECT id,status FROM mas_business_user
      WHERE identity_id=$1 FOR ${command.kind==='create'?'UPDATE':'SHARE'}`,[identityId])).rows[0];
    if(!user)throw 404;if(user.status!=='active')throw 403;
    const organizationId=command.kind==='detail'
      ?(await client.query<{organization_id:string}>('SELECT organization_id FROM mas_business_project WHERE id=$1',[command.projectId])).rows[0]?.organization_id
      :command.organizationId;
    if(!organizationId)throw 404;
    await client.query(`INSERT INTO mas_business_membership(organization_id,user_id,role)
      SELECT id,$2,'owner' FROM mas_business_organization WHERE id=$1 AND created_by=$2
      ON CONFLICT(organization_id,user_id) DO NOTHING`,[organizationId,user.id]);
    const membership=await client.query(`SELECT role FROM mas_business_membership
      WHERE organization_id=$1 AND user_id=$2 AND status='active' FOR SHARE`,[organizationId,user.id]);
    if(!membership.rowCount)throw 404;
    const observer=membership.rows[0].role==='owner';
    // Explicitly lock even suspended project rows before observing role changes.
    await client.query(`SELECT m.project_id FROM mas_business_project_member m JOIN mas_business_project p ON p.id=m.project_id
      WHERE p.organization_id=$1 AND m.user_id=$2 ORDER BY m.project_id FOR SHARE OF m`,[organizationId,user.id]);
    let result;
    if(command.kind==='list'){
      const projects=await client.query<Project>(`SELECT ${projection} FROM mas_business_project p
        LEFT JOIN mas_business_project_member m ON m.project_id=p.id AND m.user_id=$2
        WHERE p.organization_id=$1 AND (m.status='active' OR $3)
        ORDER BY p.created_at,p.id`,[organizationId,user.id,observer]);
      result={projects:projects.rows};
    }else if(command.kind==='detail'){
      result=await detail(client,user.id,command.projectId,observer);
    }else{
      const hash=createHash('sha256').update(JSON.stringify({organizationId,name:command.name,...(command.key!==undefined?{key:command.key,description:command.description??''}:{})})).digest('hex');
      const previous=(await client.query<{request_hash:string;project_id:string}>(`SELECT request_hash,project_id
        FROM mas_business_project_command WHERE user_id=$1 AND request_id=$2`,[user.id,command.requestId])).rows[0];
      if(previous){
        result=await detail(client,user.id,previous.project_id);
        if(previous.request_hash!==hash)throw 409;
      }else{
        const projectId=randomUUID(),boardId=randomUUID();
        await client.query(`INSERT INTO mas_business_project(id,organization_id,name,owner_id,default_board_id)
          VALUES ($1,$2,$3,$4,$5)`,[projectId,organizationId,command.name,user.id,boardId]);
        if(command.key!==undefined)await client.query('UPDATE mas_business_project SET key=$2,description=$3 WHERE id=$1',[projectId,command.key,command.description??'']);
        await client.query(`INSERT INTO mas_business_project_member(project_id,organization_id,user_id,role)
          VALUES ($1,$2,$3,'owner')`,[projectId,organizationId,user.id]);
        await client.query('INSERT INTO mas_business_board(id,project_id,name) VALUES ($1,$2,$3)',[boardId,projectId,'默认看板']);
        await client.query(`INSERT INTO mas_business_project_command(user_id,request_id,request_hash,project_id)
          VALUES ($1,$2,$3,$4)`,[user.id,command.requestId,hash,projectId]);
        result=await detail(client,user.id,projectId);
      }
    }
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}
