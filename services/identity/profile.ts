import type {Pool,PoolClient} from 'pg';

export type PersonalProfile={id:string;name:string;image:string|null;signature:string;version:number};

export function githubAvatar(value:unknown):string|null {
  if(typeof value!=='string'||value.length>2048)return null;
  try {
    const url=new URL(value);
    return url.origin==='https://avatars.githubusercontent.com'&&!url.username&&!url.password?url.href:null;
  }catch{return null;}
}

export async function readPersonalProfile(pool:Pick<Pool|PoolClient,'query'>,id:string):Promise<PersonalProfile|null>{
  const row=(await pool.query(`SELECT u.id,coalesce(p.name,u.name) AS name,u.image,
    coalesce(p.signature,'') AS signature,coalesce(p.version,0) AS version,p.avatar IS NOT NULL AS uploaded
    FROM mas_identity_user u LEFT JOIN mas_identity_profile p ON p.identity_id=u.id WHERE u.id=$1`,[id])).rows[0];
  return row?{id:row.id,name:row.name,signature:row.signature,version:row.version,
    image:row.uploaded?'/api/account/profile/avatar/'+row.version:githubAvatar(row.image)}:null;
}
