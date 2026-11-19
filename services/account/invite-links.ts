import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {projectTransaction} from './project-scope.ts';

const createPath=/^\/api\/account\/organizations\/([^/]+)\/invite-links$/;
const addPath=/^\/api\/account\/organizations\/([^/]+)\/members\/add$/;
const tokenSchema=z.string().regex(/^[a-f0-9]{64}$/);
const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export function inviteLinkRoute(request:Request){
  const path=new URL(request.url).pathname;
  return request.method==='POST'&&(createPath.test(path)||addPath.test(path)||['/api/account/invitation-links/inspect','/api/account/invitation-links/accept'].includes(path));
}

export async function validateInviteLink(client:PoolClient,id:string){
  const link=(await client.query(`SELECT l.*,o.name AS organization_name,u.name AS inviter_name,
    (NOT l.revoked AND l.expires_at>now() AND u.status='active' AND m.status='active' AND m.version=l.issuer_version) AS valid
    FROM mas_business_invite_link l JOIN mas_business_organization o ON o.id=l.organization_id
    JOIN mas_business_user u ON u.id=l.issued_by
    JOIN mas_business_membership m ON m.organization_id=l.organization_id AND m.user_id=l.issued_by
    WHERE l.id=$1 FOR UPDATE OF l`,[id])).rows[0];
  if(!link?.valid)throw 404;
  return link;
}

export async function handleInviteLinkRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  const path=new URL(request.url).pathname,create=createPath.exec(path),add=addPath.exec(path);
  const body=await readBoundedJson(request);
  if(create){
    const organizationId=z.uuid().parse(create[1]);
    const input=z.object({token:tokenSchema,requestId:z.uuid(),maxUses:z.number().int().min(1).max(500),hours:z.number().int().min(1).max(48)}).strict().parse(body);
    return projectTransaction(pool,async client=>{
      const user=(await client.query("SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR UPDATE",[principal.id])).rows[0];
      if(!user||user.status!=='active')throw 403;
      const member=(await client.query('SELECT role,status,version FROM mas_business_membership WHERE organization_id=$1 AND user_id=$2 FOR SHARE',[organizationId,user.id])).rows[0];
      if(member?.status!=='active')throw 403;
      let link=(await client.query('SELECT * FROM mas_business_invite_link WHERE issued_by=$1 AND request_id=$2',[user.id,input.requestId])).rows[0];
      const hash=tokenHash(input.token);
      if(link){if(link.organization_id!==organizationId||link.token_hash!==hash||link.max_uses!==input.maxUses||link.hours!==input.hours||link.issuer_version!==member.version)throw 409;}
      else link=(await client.query(`INSERT INTO mas_business_invite_link(id,organization_id,issued_by,issuer_version,token_hash,request_id,max_uses,hours,approval_required,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::integer,$9,now()+$8::integer*interval '1 hour') RETURNING *`,[randomUUID(),organizationId,user.id,member.version,hash,input.requestId,input.maxUses,input.hours,member.role!=='owner'])).rows[0];
      return {link:{id:link.id,expiresAt:link.expires_at,maxUses:link.max_uses,approvalRequired:link.approval_required}};
    });
  }
  if(add){
    const organizationId=z.uuid().parse(add[1]);
    const input=z.object({email:z.string().trim().toLowerCase().pipe(z.email().max(254)),requestId:z.uuid()}).strict().parse(body);
    return projectTransaction(pool,async client=>{
      // Authorize before looking up a registered address; never expose a directory.
      const actor=(await client.query('SELECT id,status FROM mas_business_user WHERE identity_id=$1',[principal.id])).rows[0];
      if(!actor||actor.status!=='active')throw 403;
      const access=(await client.query("SELECT 1 FROM mas_business_membership WHERE organization_id=$1 AND user_id=$2 AND role='owner' AND status='active'",[organizationId,actor.id])).rows[0];
      if(!access)throw 403;
      const identity=(await client.query('SELECT u.id,coalesce(p.name,u.name) AS name FROM mas_identity_user u LEFT JOIN mas_identity_profile p ON p.identity_id=u.id WHERE lower(u.email)=$1 AND u."emailVerified"=true',[input.email])).rows[0];
      if(!identity)throw 404;
      await client.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3) ON CONFLICT(identity_id) DO NOTHING',[randomUUID(),identity.id,identity.name]);
      const target=(await client.query('SELECT id FROM mas_business_user WHERE identity_id=$1',[identity.id])).rows[0];
      const ids=[...new Set([actor.id,target.id])].sort();
      const users=(await client.query('SELECT id,status FROM mas_business_user WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
      if(users.some(u=>u.status!=='active'))throw 403;
      const members=(await client.query('SELECT user_id,role,status FROM mas_business_membership WHERE organization_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR UPDATE',[organizationId,ids])).rows;
      if(!members.some(m=>m.user_id===actor.id&&m.role==='owner'&&m.status==='active'))throw 403;
      const current=members.find(m=>m.user_id===target.id);
      const previous=(await client.query('SELECT organization_id,target_id,email FROM mas_business_member_add_command WHERE issued_by=$1 AND request_id=$2',[actor.id,input.requestId])).rows[0];
      if(previous){
        if(previous.organization_id!==organizationId||previous.target_id!==target.id||previous.email!==input.email||current?.status!=='active')throw 409;
        return {ok:true};
      }
      if(!current)await client.query("INSERT INTO mas_business_membership(organization_id,user_id,role,invited_by) VALUES($1,$2,'member',$3)",[organizationId,target.id,actor.id]);
      else if(current.status==='suspended')await client.query("UPDATE mas_business_membership SET status='active',joined_at=now(),invited_by=$3,version=version+1 WHERE organization_id=$1 AND user_id=$2",[organizationId,target.id,actor.id]);
      await client.query("UPDATE mas_business_join_request SET status='approved',decided_by=$3,decided_at=now() WHERE organization_id=$1 AND user_id=$2 AND status='pending'",[organizationId,target.id,actor.id]);
      await client.query('INSERT INTO mas_business_member_add_command(issued_by,request_id,organization_id,target_id,email) VALUES($1,$2,$3,$4,$5)',[actor.id,input.requestId,organizationId,target.id,input.email]);
      return {ok:true};
    });
  }
  const {token}=z.object({token:tokenSchema}).strict().parse(body);
  return projectTransaction(pool,async client=>{
    const observed=(await client.query('SELECT id,issued_by,organization_id FROM mas_business_invite_link WHERE token_hash=$1',[tokenHash(token)])).rows[0];
    if(!observed)throw 404;
    const identity=(await client.query('SELECT "emailVerified" FROM mas_identity_user WHERE id=$1',[principal.id])).rows[0];
    if(!identity?.emailVerified)throw 403;
    await client.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3) ON CONFLICT(identity_id) DO NOTHING',[randomUUID(),principal.id,principal.name]);
    const recipient=(await client.query('SELECT id FROM mas_business_user WHERE identity_id=$1',[principal.id])).rows[0];
    const ids=[...new Set([observed.issued_by,recipient.id])].sort();
    const users=(await client.query('SELECT id,status FROM mas_business_user WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
    if(users.some(u=>u.status!=='active'))throw 403;
    const members=(await client.query('SELECT user_id,status FROM mas_business_membership WHERE organization_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR UPDATE',[observed.organization_id,ids])).rows;
    const current=members.find(m=>m.user_id===recipient.id);
    if(current?.status==='suspended')throw 403;
    const link=await validateInviteLink(client,observed.id);
    const claim=(await client.query('SELECT c.join_request_id,r.status FROM mas_business_invite_claim c LEFT JOIN mas_business_join_request r ON r.id=c.join_request_id WHERE c.link_id=$1 AND c.user_id=$2',[link.id,recipient.id])).rows[0];
    const status=current?.status==='active'?'joined':claim?.status??'available';
    if(path.endsWith('/inspect'))return {invitation:{organizationName:link.organization_name,inviterName:link.inviter_name,expiresAt:link.expires_at,approvalRequired:link.approval_required,remaining:Math.max(0,link.max_uses-link.uses),status}};
    if(current?.status==='active')return {status:'joined'};
    if(claim)return {status:claim.status??'joined'};
    if(link.uses>=link.max_uses)throw 409;
    let requestId:string|null=null;
    if(link.approval_required){
      let pending=(await client.query("SELECT id,invite_link_id FROM mas_business_join_request WHERE organization_id=$1 AND user_id=$2 AND status='pending' FOR UPDATE",[link.organization_id,recipient.id])).rows[0];
      if(pending?.invite_link_id&&pending.invite_link_id!==link.id)throw 409;
      if(!pending)pending=(await client.query('INSERT INTO mas_business_join_request(id,organization_id,user_id,invite_link_id) VALUES($1,$2,$3,$4) RETURNING id',[randomUUID(),link.organization_id,recipient.id,link.id])).rows[0];
      else await client.query('UPDATE mas_business_join_request SET invite_link_id=$2 WHERE id=$1',[pending.id,link.id]);
      requestId=pending.id;
    }else{
      await client.query("INSERT INTO mas_business_membership(organization_id,user_id,role,invited_by) VALUES($1,$2,'member',$3)",[link.organization_id,recipient.id,link.issued_by]);
      await client.query("UPDATE mas_business_join_request SET status='approved',decided_by=$3,decided_at=now() WHERE organization_id=$1 AND user_id=$2 AND status='pending'",[link.organization_id,recipient.id,link.issued_by]);
    }
    await client.query('INSERT INTO mas_business_invite_claim(link_id,user_id,join_request_id) VALUES($1,$2,$3)',[link.id,recipient.id,requestId]);
    await client.query('UPDATE mas_business_invite_link SET uses=uses+1 WHERE id=$1',[link.id]);
    return {status:requestId?'pending':'joined'};
  });
}
