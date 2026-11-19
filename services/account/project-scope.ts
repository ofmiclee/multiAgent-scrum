import type {Pool,PoolClient} from 'pg';

export async function projectTransaction<T>(pool:Pool,operation:(client:PoolClient)=>Promise<T>){
  const client=await pool.connect();
  let discard=false;
  try{await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');return result;}
  catch(error){
    try{await client.query('ROLLBACK');}catch{discard=true;}
    throw error;
  }
  finally{client.release(discard);}
}

/** Lock order is user -> organization membership -> project membership.
 * Mutations serialize this actor's receipts; every read/replay rechecks access. */
export async function authorizeProject(client:PoolClient,identityId:string,projectId:string,write:boolean){
  return authorize(client,identityId,projectId,write,false);
}

/** Business content only: organization ownership never grants management or writes. */
export async function authorizeProjectContent(client:PoolClient,identityId:string,projectId:string){
  return authorize(client,identityId,projectId,false,true);
}

async function authorize(client:PoolClient,identityId:string,projectId:string,write:boolean,content:boolean){
  const user=(await client.query<{id:string;status:string}>(`SELECT id,status FROM mas_business_user
    WHERE identity_id=$1 FOR ${write?'UPDATE':'SHARE'}`,[identityId])).rows[0];
  if(!user)throw 404;if(user.status!=='active')throw 403;
  const project=(await client.query<{organization_id:string}>('SELECT organization_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0];
  if(!project)throw 404;
  const organization=(await client.query<{status:string;role:string}>(`SELECT status,role FROM mas_business_membership
    WHERE organization_id=$1 AND user_id=$2 FOR SHARE`,[project.organization_id,user.id])).rows[0];
  if(!organization)throw 404;if(organization.status!=='active')throw 403;
  const membership=(await client.query<{status:string;role:string}>(`SELECT status,role FROM mas_business_project_member
    WHERE project_id=$1 AND user_id=$2 FOR SHARE`,[projectId,user.id])).rows[0];
  if((!membership||membership.status!=='active')&&!(content&&organization.role==='owner'))throw 404;
  if(write&&membership?.role==='viewer')throw 403;
  return {...user,projectRole:membership?.status==='active'?membership.role:'viewer'};
}
