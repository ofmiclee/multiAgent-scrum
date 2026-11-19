import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';

type Invitation={id:string;email:string;status:string;expiresAt:Date|string};
type Member={id:string;name:string;role:string;status:string;version?:number};
type BusinessUser={id:string;status:string};

async function transaction<T>(pool:Pool,operation:(client:PoolClient)=>Promise<T>){
  const client=await pool.connect();
  try{await client.query('BEGIN');const result=await operation(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

async function actor(client:PoolClient,identityId:string,lock:'SHARE'|'UPDATE'='SHARE'){
  const user=(await client.query<BusinessUser>(`SELECT id,status FROM mas_business_user
    WHERE identity_id=$1 FOR ${lock}`,[identityId])).rows[0];
  if(!user)throw 404;if(user.status!=='active')throw 403;return user;
}

async function organizationMembership(client:PoolClient,organizationId:string,userId:string,ownerOnly=false){
  const membership=(await client.query<{role:string;status:string}>(`SELECT role,status FROM mas_business_membership
    WHERE organization_id=$1 AND user_id=$2 FOR SHARE`,[organizationId,userId])).rows[0];
  if(!membership)throw 404;
  if(membership.status!=='active'||(ownerOnly&&membership.role!=='owner'))throw 403;
  return membership;
}

/** Owner authorization is locked before actor-scoped receipt lookup. */
export async function issueInvitation(pool:Pool,identityId:string,organizationId:string,email:string,requestId:string){
  return transaction(pool,async client=>{
    const user=await actor(client,identityId,'UPDATE');
    await organizationMembership(client,organizationId,user.id,true);
    const hash=createHash('sha256').update(JSON.stringify({organizationId,email})).digest('hex');
    const previous=(await client.query<{request_hash:string;invitation_id:string}>(`SELECT request_hash,invitation_id
      FROM mas_business_invitation_command WHERE user_id=$1 AND request_id=$2`,[user.id,requestId])).rows[0];
    let invitation:Invitation;
    if(previous){
      if(previous.request_hash!==hash)throw 409;
      invitation=(await client.query<Invitation>(`SELECT id,email,status,expires_at AS "expiresAt"
        FROM mas_business_invitation WHERE id=$1`,[previous.invitation_id])).rows[0]!;
    }else{
      const id=randomUUID();
      invitation=(await client.query<Invitation>(`INSERT INTO mas_business_invitation
        (id,organization_id,email,issued_by,expires_at) VALUES ($1,$2,$3,$4,now()+interval '7 days')
        RETURNING id,email,status,expires_at AS "expiresAt"`,[id,organizationId,email,user.id])).rows[0]!;
      await client.query(`INSERT INTO mas_business_invitation_command(user_id,request_id,request_hash,invitation_id)
        VALUES ($1,$2,$3,$4)`,[user.id,requestId,hash,id]);
    }
    return {invitation};
  });
}

async function verifiedIdentity(client:PoolClient,identityId:string){
  const identity=(await client.query<{id:string;name:string;email:string;emailVerified:boolean}>(`SELECT id,name,email,
    "emailVerified" AS "emailVerified" FROM mas_identity_user WHERE id=$1`,[identityId])).rows[0];
  if(!identity||!identity.emailVerified)throw 403;
  return {...identity,email:identity.email.trim().toLowerCase()};
}

export async function listRecipientInvitations(pool:Pool,identityId:string){
  return transaction(pool,async client=>{
    const identity=await verifiedIdentity(client,identityId);
    const invitations=await client.query<{id:string;organizationId:string;organizationName:string;expiresAt:Date|string}>(`SELECT
      i.id,i.organization_id AS "organizationId",o.name AS "organizationName",i.expires_at AS "expiresAt"
      FROM mas_business_invitation i JOIN mas_business_organization o ON o.id=i.organization_id
      WHERE i.email=$1 AND i.status='pending' AND i.expires_at>now()
      ORDER BY i.created_at,i.id`,[identity.email]);
    return {invitations:invitations.rows};
  });
}

export async function listOrganizationInvitations(pool:Pool,identityId:string,organizationId:string){
  return transaction(pool,async client=>{
    const user=await actor(client,identityId);await organizationMembership(client,organizationId,user.id,true);
    const invitations=await client.query<Invitation>(`SELECT id,email,status,expires_at AS "expiresAt"
      FROM mas_business_invitation WHERE organization_id=$1 ORDER BY created_at,id`,[organizationId]);
    return {invitations:invitations.rows};
  });
}

export async function revokeInvitation(pool:Pool,identityId:string,organizationId:string,invitationId:string){
  return transaction(pool,async client=>{
    const user=await actor(client,identityId,'UPDATE');await organizationMembership(client,organizationId,user.id,true);
    const invitation=(await client.query<{status:string}>(`SELECT status FROM mas_business_invitation
      WHERE id=$1 AND organization_id=$2 FOR UPDATE`,[invitationId,organizationId])).rows[0];
    if(!invitation)throw 404;
    if(invitation.status==='pending')await client.query("UPDATE mas_business_invitation SET status='revoked' WHERE id=$1",[invitationId]);
    return {ok:true};
  });
}

/** Acceptance locks all business users in UUID order, then all organization
 * memberships in the same order, and only then serializes on the invitation. */
export async function acceptInvitation(pool:Pool,principal:{id:string;name:string},invitationId:string){
  return transaction(pool,async client=>{
    const identity=await verifiedIdentity(client,principal.id);
    const observed=(await client.query<{organization_id:string;email:string;issued_by:string;status:string;expires_at:Date;accepted_by:string|null}>(`SELECT
      organization_id,email,issued_by,status,expires_at,accepted_by FROM mas_business_invitation WHERE id=$1`,[invitationId])).rows[0];
    if(!observed||observed.email!==identity.email||observed.status==='revoked'||
      (observed.status==='pending'&&observed.expires_at.getTime()<=Date.now()))throw 404;

    await client.query(`INSERT INTO mas_business_user(id,identity_id,name) VALUES ($1,$2,$3)
      ON CONFLICT (identity_id) DO NOTHING`,[randomUUID(),principal.id,principal.name]);
    const recipient=(await client.query<BusinessUser>('SELECT id,status FROM mas_business_user WHERE identity_id=$1',[principal.id])).rows[0];
    if(!recipient)throw 503;
    const ids=[observed.issued_by,recipient.id].filter((value,index,all)=>all.indexOf(value)===index).sort();
    const users=await client.query<BusinessUser>(`SELECT id,status FROM mas_business_user
      WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,[ids]);
    const byId=new Map(users.rows.map(user=>[user.id,user]));
    const issuer=byId.get(observed.issued_by),lockedRecipient=byId.get(recipient.id);
    if(!issuer||issuer.status!=='active')throw 403;
    if(!lockedRecipient||lockedRecipient.status!=='active')throw 403;

    const memberships=await client.query<{user_id:string;role:string;status:string}>(`SELECT user_id,role,status
      FROM mas_business_membership WHERE organization_id=$1 AND user_id=ANY($2::uuid[])
      ORDER BY user_id FOR UPDATE`,[observed.organization_id,ids]);
    const membershipByUser=new Map(memberships.rows.map(membership=>[membership.user_id,membership]));
    const issuerMembership=membershipByUser.get(observed.issued_by);
    if(!issuerMembership||issuerMembership.status!=='active'||issuerMembership.role!=='owner')throw 403;
    const recipientMembership=membershipByUser.get(recipient.id);
    if(recipientMembership?.status==='suspended')throw 403;

    const invitation=(await client.query<typeof observed>(`SELECT organization_id,email,issued_by,status,expires_at,accepted_by
      FROM mas_business_invitation WHERE id=$1 FOR UPDATE`,[invitationId])).rows[0];
    if(!invitation||invitation.email!==identity.email||invitation.status==='revoked'||
      (invitation.status==='pending'&&invitation.expires_at.getTime()<=Date.now()))throw 404;
    if(invitation.status==='accepted'){
      if(invitation.accepted_by!==recipient.id||!recipientMembership||recipientMembership.status!=='active')throw 404;
    }else{
      if(!recipientMembership)await client.query(`INSERT INTO mas_business_membership(organization_id,user_id,role)
        VALUES ($1,$2,'member')`,[invitation.organization_id,recipient.id]);
      await client.query("UPDATE mas_business_invitation SET status='accepted',accepted_by=$2 WHERE id=$1",[invitationId,recipient.id]);
    }
    const organization=(await client.query(`SELECT id,name,to_jsonb(o)->>'slug' AS slug,to_jsonb(o)->>'alias' AS alias,to_jsonb(o)->>'description' AS description,
      coalesce((to_jsonb(o)->>'version')::integer,1) AS version,CASE WHEN to_jsonb(o)->>'avatar' IS NULL THEN NULL ELSE '/api/account/organizations/'||o.id||'/avatar/'||coalesce((to_jsonb(o)->>'version')::integer,1) END AS image FROM mas_business_organization o
      WHERE id=$1`,[invitation.organization_id])).rows[0];
    if(!organization)throw 404;
    return {organization:{...organization,role:recipientMembership?.role??'member'}};
  });
}

export async function listOrganizationMembers(pool:Pool,identityId:string,organizationId:string){
  return transaction(pool,async client=>{
    const user=await actor(client,identityId);await organizationMembership(client,organizationId,user.id);
    const members=await client.query<Member>(`SELECT u.id,u.name,m.role,m.status,coalesce((to_jsonb(m)->>'version')::integer,1) AS version,
      m.joined_at AS "joinedAt",(SELECT name FROM mas_business_user WHERE id=m.invited_by) AS "invitedBy" FROM mas_business_membership m
      JOIN mas_business_user u ON u.id=m.user_id
      WHERE m.organization_id=$1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,u.created_at,u.id`,[organizationId]);
    return {members:members.rows};
  });
}

async function projectOrganization(client:PoolClient,projectId:string){
  const row=(await client.query<{organization_id:string}>('SELECT organization_id FROM mas_business_project WHERE id=$1',[projectId])).rows[0];
  if(!row)throw 404;return row.organization_id;
}

export async function listProjectMembers(pool:Pool,identityId:string,projectId:string){
  return transaction(pool,async client=>{
    const user=await actor(client,identityId),organizationId=await projectOrganization(client,projectId);
    await organizationMembership(client,organizationId,user.id);
    const access=(await client.query(`SELECT 1 FROM mas_business_project_member
      WHERE project_id=$1 AND user_id=$2 AND status='active' FOR SHARE`,[projectId,user.id])).rows[0];
    if(!access)throw 404;
    const members=await client.query<Member>(`SELECT u.id,u.name,m.role,m.status,m.version,m.joined_at AS "joinedAt"
      FROM mas_business_project_member m JOIN mas_business_user u ON u.id=m.user_id
      JOIN mas_business_project p ON p.id=m.project_id
      JOIN mas_business_membership om ON om.organization_id=p.organization_id AND om.user_id=m.user_id AND om.status='active'
      WHERE m.project_id=$1 ORDER BY CASE m.role WHEN 'owner' THEN 0 ELSE 1 END,u.created_at,u.id`,[projectId]);
    return {members:members.rows};
  });
}

export async function changeProjectMember(pool:Pool,identityId:string,projectId:string,input:{userId:string;status:'active'|'suspended';expectedVersion:number;role?:'member'|'manager'|'viewer'}){
  return transaction(pool,async client=>{
    const organizationId=await projectOrganization(client,projectId);
    const observedActor=(await client.query<{id:string}>('SELECT id FROM mas_business_user WHERE identity_id=$1',[identityId])).rows[0];
    if(!observedActor)throw 404;
    const ids=[observedActor.id,input.userId].filter((value,index,all)=>all.indexOf(value)===index).sort();
    const users=await client.query<BusinessUser>(`SELECT id,status FROM mas_business_user
      WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,[ids]);
    const byId=new Map(users.rows.map(user=>[user.id,user]));
    const currentActor=byId.get(observedActor.id),target=byId.get(input.userId);
    if(!currentActor)throw 404;if(currentActor.status!=='active')throw 403;

    const organizationMemberships=await client.query<{user_id:string;status:string}>(`SELECT user_id,status
      FROM mas_business_membership WHERE organization_id=$1 AND user_id=ANY($2::uuid[])
      ORDER BY user_id FOR UPDATE`,[organizationId,ids]);
    const orgByUser=new Map(organizationMemberships.rows.map(membership=>[membership.user_id,membership]));
    const actorOrganization=orgByUser.get(currentActor.id),targetOrganization=orgByUser.get(input.userId);
    if(!actorOrganization)throw 404;if(actorOrganization.status!=='active')throw 403;

    const projectMemberships=await client.query<{user_id:string;role:string;status:string;version:number}>(`SELECT user_id,role,status,version
      FROM mas_business_project_member WHERE project_id=$1 AND user_id=ANY($2::uuid[])
      ORDER BY user_id FOR UPDATE`,[projectId,ids]);
    const projectByUser=new Map(projectMemberships.rows.map(membership=>[membership.user_id,membership]));
    const actorProject=projectByUser.get(currentActor.id),targetProject=projectByUser.get(input.userId);
    if(!actorProject||actorProject.status!=='active')throw 404;
    if(!['owner','manager'].includes(actorProject.role))throw 403;
    if(actorProject.role==='manager'&&(targetProject?.role==='manager'||input.role==='manager'))throw 403;
    if(!target||target.status!=='active')throw 404;
    if(!targetOrganization||targetOrganization.status!=='active')throw 404;
    if(currentActor.id===target.id||targetProject?.role==='owner')throw 403;
    let member:Member;
    if(!targetProject){
      if(input.expectedVersion!==0)throw 409;if(input.status!=='active')throw 400;
      member=(await client.query<Member>(`INSERT INTO mas_business_project_member
        (project_id,organization_id,user_id,role,status) VALUES ($1,$2,$3,$4,'active')
        RETURNING user_id AS id,(SELECT name FROM mas_business_user WHERE id=user_id),role,status,version,joined_at AS "joinedAt"`,
        [projectId,organizationId,target.id,input.role??'member'])).rows[0]!;
    }else{
      if(input.expectedVersion!==targetProject.version)throw 409;
      member=(await client.query<Member>(`UPDATE mas_business_project_member SET status=$3,role=$4,version=version+1,
        joined_at=CASE WHEN status='suspended' AND $3='active' THEN now() ELSE joined_at END
        WHERE project_id=$1 AND user_id=$2
        RETURNING user_id AS id,(SELECT name FROM mas_business_user WHERE id=user_id),role,status,version,joined_at AS "joinedAt"`,
        [projectId,target.id,input.status,input.role??targetProject.role])).rows[0]!;
    }
    if(input.status==='suspended'||input.role==='viewer')await client.query('UPDATE mas_business_agent_project SET enabled=false,version=version+1 WHERE project_id=$1 AND owner_id=$2 AND enabled',[projectId,target.id]);
    return {member};
  });
}
