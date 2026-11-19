import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Pool,PoolClient} from 'pg';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {authorizeProject,projectTransaction} from './project-scope.ts';
import {validateInviteLink} from './invite-links.ts';
import {decodeAvatar,profileUploadLimit} from './profile.ts';

const organizationPath=/^\/api\/account\/organizations\/([^/]+)$/;
const avatarPath=/^\/api\/account\/organizations\/([^/]+)\/avatar\/([1-9][0-9]{0,9})$/;
const membersPath=/^\/api\/account\/organizations\/([^/]+)\/members$/;
const requestsPath=/^\/api\/account\/organizations\/([^/]+)\/join-requests(?:\/([^/]+))?$/;
const settingsPath=/^\/api\/account\/projects\/([^/]+)\/settings$/;
const submitPath='/api/account/organization-join-requests';
const slug=z.string().trim().toLowerCase().min(1).max(50).regex(/^[a-z0-9]([a-z0-9_.-]*[a-z0-9])?$/);
const expectedVersion=z.number().int().positive();
const organizationInput=z.object({alias:z.string().trim().min(1).max(50),description:z.string().trim().max(200),slug:slug.optional(),expectedVersion,
  avatar:z.string().min(1).max(13981016).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional()}).strict();
const projectInput=z.object({name:z.string().trim().min(1).max(120),description:z.string().trim().max(200),key:z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/).optional(),expectedVersion}).strict();
const organizationProjection=`id,name,slug,alias,description,version,
  CASE WHEN avatar IS NULL THEN NULL ELSE '/api/account/organizations/'||id||'/avatar/'||version END AS image`;
const requestProjection='id,organization_id AS "organizationId",user_id AS "userId",status,created_at AS "createdAt",decided_at AS "decidedAt"';

export function organizationRoute(request:Request){
  const path=new URL(request.url).pathname;
  return (request.method==='GET'&&(organizationPath.test(path)||avatarPath.test(path)||requestsPath.test(path)||settingsPath.test(path)))||
    (request.method==='POST'&&(path===submitPath||organizationPath.test(path)||membersPath.test(path)||requestsPath.test(path)||settingsPath.test(path)));
}
async function actor(client:PoolClient,identityId:string,write=false){
  const user=(await client.query<{id:string;status:string}>(`SELECT id,status FROM mas_business_user WHERE identity_id=$1 FOR ${write?'UPDATE':'SHARE'}`,[identityId])).rows[0];
  if(!user)throw 404;if(user.status!=='active')throw 403;return user;
}
async function membership(client:PoolClient,organizationId:string,userId:string,owner=false){
  const member=(await client.query<{role:string;status:string}>('SELECT role,status FROM mas_business_membership WHERE organization_id=$1 AND user_id=$2 FOR SHARE',[organizationId,userId])).rows[0];
  if(!member)throw 404;if(member.status!=='active'||(owner&&member.role!=='owner'))throw 403;return member;
}

export async function handleOrganizationRequest(pool:Pool,principal:IdentityPrincipal,request:Request){
  const path=new URL(request.url).pathname,write=request.method==='POST';
  const avatarMatch=avatarPath.exec(path);
  if(avatarMatch){
    const organizationId=z.uuid().parse(avatarMatch[1]),version=z.coerce.number().int().positive().parse(avatarMatch[2]);
    return projectTransaction(pool,async client=>{
      const user=await actor(client,principal.id),access=await membership(client,organizationId,user.id);
      void access;
      const row=(await client.query('SELECT avatar,version FROM mas_business_organization WHERE id=$1',[organizationId])).rows[0];
      if(!row?.avatar||row.version!==version)throw 404;
      return new Response(new Uint8Array(row.avatar),{headers:{'Cache-Control':'no-store','Content-Type':'image/webp','Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff','X-MAS-Identity':principal.id}});
    });
  }
  if(path===submitPath){
    const input=z.object({slug,requestId:z.uuid()}).strict().parse(await readBoundedJson(request));
    return projectTransaction(pool,async client=>{
      await client.query('INSERT INTO mas_business_user(id,identity_id,name) VALUES($1,$2,$3) ON CONFLICT(identity_id) DO NOTHING',[randomUUID(),principal.id,principal.name]);
      const user=await actor(client,principal.id,true);
      const organization=(await client.query('SELECT id FROM mas_business_organization WHERE slug=$1',[input.slug])).rows[0];if(!organization)throw 404;
      const current=(await client.query('SELECT status FROM mas_business_membership WHERE organization_id=$1 AND user_id=$2 FOR SHARE',[organization.id,user.id])).rows[0];
      if(current?.status==='suspended')throw 403;
      const previous=(await client.query('SELECT slug,join_request_id FROM mas_business_join_command WHERE user_id=$1 AND request_id=$2',[user.id,input.requestId])).rows[0];
      if(previous){
        if(previous.slug!==input.slug)throw 409;
        return {request:(await client.query(`SELECT ${requestProjection} FROM mas_business_join_request WHERE id=$1`,[previous.join_request_id])).rows[0]};
      }
      if(current)throw 409;
      let pending=(await client.query(`SELECT ${requestProjection} FROM mas_business_join_request WHERE organization_id=$1 AND user_id=$2 AND status='pending'`,[organization.id,user.id])).rows[0];
      if(!pending)pending=(await client.query(`INSERT INTO mas_business_join_request(id,organization_id,user_id) VALUES($1,$2,$3) RETURNING ${requestProjection}`,[randomUUID(),organization.id,user.id])).rows[0];
      await client.query('INSERT INTO mas_business_join_command(user_id,request_id,slug,join_request_id) VALUES($1,$2,$3,$4)',[user.id,input.requestId,input.slug,pending.id]);
      return {request:pending};
    });
  }
  const settings=settingsPath.exec(path);
  if(settings){
    const projectId=z.uuid().parse(settings[1]),input=write?projectInput.parse(await readBoundedJson(request)):null;
    return projectTransaction(pool,async client=>{
      const user=await authorizeProject(client,principal.id,projectId,write);
      const project=(await client.query(`SELECT id,name,key,description,version,owner_id FROM mas_business_project WHERE id=$1 ${write?'FOR UPDATE':''}`,[projectId])).rows[0];
      if(input){
        if(project.owner_id!==user.id)throw 403;
        if(project.version!==input.expectedVersion||(input.key!==undefined&&project.key!==null&&project.key!==input.key))throw 409;
        await client.query('UPDATE mas_business_project SET name=$2,description=$3,key=coalesce(key,$4),version=version+1 WHERE id=$1',[projectId,input.name,input.description,input.key??null]);
      }
      return {project:(await client.query('SELECT id,name,key,description,version FROM mas_business_project WHERE id=$1',[projectId])).rows[0]};
    });
  }
  const requestMatch=requestsPath.exec(path),memberMatch=membersPath.exec(path),info=organizationPath.exec(path);
  const organizationId=z.uuid().parse((requestMatch??memberMatch??info)![1]);
  if(requestMatch?.[2]||memberMatch){
    const input=memberMatch?z.object({userId:z.uuid(),status:z.enum(['active','suspended']),expectedVersion}).strict().parse(await readBoundedJson(request)):
      z.object({decision:z.enum(['approve','reject'])}).strict().parse(await readBoundedJson(request));
    if(!write)throw 404;
    return projectTransaction(pool,async client=>{
      const observedActor=(await client.query('SELECT id FROM mas_business_user WHERE identity_id=$1',[principal.id])).rows[0];if(!observedActor)throw 404;
      const requestId=requestMatch?.[2]?z.uuid().parse(requestMatch[2]):null;
      const observed=requestId?(await client.query('SELECT r.user_id,r.invite_link_id,l.issued_by FROM mas_business_join_request r LEFT JOIN mas_business_invite_link l ON l.id=r.invite_link_id WHERE r.id=$1 AND r.organization_id=$2',[requestId,organizationId])).rows[0]:null;
      if(requestId&&!observed)throw 404;
      const targetId='userId'in input?input.userId:observed.user_id;
      const ids=[...new Set([observedActor.id,targetId,...(observed?.issued_by?[observed.issued_by]:[])])].sort();
      const users=(await client.query('SELECT id,status FROM mas_business_user WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[ids])).rows;
      if(users.find(u=>u.id===observedActor.id)?.status!=='active')throw 403;
      if(users.find(u=>u.id===targetId)?.status!=='active')throw 403;
      const members=(await client.query('SELECT user_id,role,status,version FROM mas_business_membership WHERE organization_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR UPDATE',[organizationId,ids])).rows;
      const current=members.find(m=>m.user_id===observedActor.id),target=members.find(m=>m.user_id===targetId);
      if(!current)throw 404;if(current.status!=='active'||current.role!=='owner')throw 403;
      if(targetId===observedActor.id||target?.role==='owner')throw 403;
      if('status'in input){
        if(!target)throw 404;if(target.version!==input.expectedVersion)throw 409;
        const member=(await client.query('UPDATE mas_business_membership SET status=$3,version=version+1 WHERE organization_id=$1 AND user_id=$2 RETURNING user_id AS id,role,status,version',[organizationId,targetId,input.status])).rows[0];
        if(input.status==='suspended'){
          await client.query("UPDATE mas_business_project_member SET status='suspended',version=version+1 WHERE organization_id=$1 AND user_id=$2 AND status='active'",[organizationId,targetId]);
          await client.query('UPDATE mas_business_agent_project SET enabled=false,version=version+1 WHERE owner_id=$2 AND project_id IN (SELECT id FROM mas_business_project WHERE organization_id=$1) AND enabled',[organizationId,targetId]);
          await client.query('UPDATE mas_business_invite_link SET revoked=true WHERE organization_id=$1 AND issued_by=$2',[organizationId,targetId]);
          await client.query("UPDATE mas_business_join_request SET status='rejected',decided_by=$3,decided_at=now() WHERE organization_id=$1 AND user_id=$2 AND status='pending'",[organizationId,targetId,observedActor.id]);
        }
        return {member};
      }
      if(target?.status==='suspended')throw 403;
      const link=observed?.invite_link_id&&input.decision==='approve'?await validateInviteLink(client,observed.invite_link_id):null;
      const application=(await client.query('SELECT status,invite_link_id FROM mas_business_join_request WHERE id=$1 AND organization_id=$2 FOR UPDATE',[requestId,organizationId])).rows[0];
      if(application.invite_link_id!==observed.invite_link_id)throw 409;
      const status=input.decision==='approve'?'approved':'rejected';
      if(application.status!=='pending'&&application.status!==status)throw 409;
      if(application.status==='pending'){
        if(status==='approved'&&!target)await client.query("INSERT INTO mas_business_membership(organization_id,user_id,role,invited_by) VALUES($1,$2,'member',$3)",[organizationId,targetId,link?.issued_by??null]);
        await client.query('UPDATE mas_business_join_request SET status=$2,decided_by=$3,decided_at=now() WHERE id=$1',[requestId,status,observedActor.id]);
      }
      return {request:(await client.query(`SELECT ${requestProjection} FROM mas_business_join_request WHERE id=$1`,[requestId])).rows[0]};
    });
  }
  const input=write?organizationInput.parse(await readBoundedJson(request,profileUploadLimit)):null;
  return projectTransaction(pool,async client=>{
    const user=await actor(client,principal.id,write),access=await membership(client,organizationId,user.id,write||!!requestMatch);
    if(requestMatch)return {requests:(await client.query(`SELECT ${requestProjection},(SELECT name FROM mas_business_user WHERE id=user_id) AS name,
      (SELECT u.name FROM mas_business_invite_link l JOIN mas_business_user u ON u.id=l.issued_by WHERE l.id=invite_link_id) AS "invitedBy"
      FROM mas_business_join_request WHERE organization_id=$1 ORDER BY created_at,id`,[organizationId])).rows};
    if(input){
      const org=(await client.query('SELECT slug,version FROM mas_business_organization WHERE id=$1 FOR UPDATE',[organizationId])).rows[0];
      if(org.version!==input.expectedVersion||(input.slug!==undefined&&org.slug!==null&&org.slug!==input.slug))throw 409;
      const avatar=input.avatar?await decodeAvatar(input.avatar):null;
      await client.query("UPDATE mas_business_organization SET alias=$2,description=$3,slug=coalesce(slug,$4),name=$2,avatar=coalesce($5,avatar),version=version+1 WHERE id=$1",[organizationId,input.alias,input.description,input.slug??null,avatar]);
    }
    return {organization:{...(await client.query(`SELECT ${organizationProjection} FROM mas_business_organization WHERE id=$1`,[organizationId])).rows[0],role:access.role}};
  });
}
