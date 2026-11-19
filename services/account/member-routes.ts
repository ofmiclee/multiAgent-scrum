import type {Pool} from 'pg';
import {z} from 'zod';
import type {IdentityPrincipal} from '../identity/service.ts';
import {readBoundedJson} from '../identity/request.ts';
import {acceptInvitation,changeProjectMember,issueInvitation,listOrganizationInvitations,listOrganizationMembers,
  listProjectMembers,listRecipientInvitations,revokeInvitation} from './members.ts';

const inboxPath='/api/account/invitations';
const organizationInvitations=/^\/api\/account\/organizations\/([^/]+)\/invitations$/;
const revokePath=/^\/api\/account\/organizations\/([^/]+)\/invitations\/([^/]+)\/revoke$/;
const acceptPath=/^\/api\/account\/invitations\/([^/]+)\/accept$/;
const organizationMembers=/^\/api\/account\/organizations\/([^/]+)\/members$/;
const projectMembers=/^\/api\/account\/projects\/([^/]+)\/members$/;
const uuid=z.uuid().transform(value=>value.toLowerCase());
const invitationSchema=z.object({email:z.string().trim().toLowerCase().pipe(z.email().max(254)),requestId:uuid}).strict();
const emptySchema=z.object({}).strict();
const projectMemberSchema=z.object({userId:uuid,status:z.enum(['active','suspended']),expectedVersion:z.number().int().min(0),role:z.enum(['member','manager','viewer']).optional()}).strict();

export function memberRoute(request:Request):boolean{
  const path=new URL(request.url).pathname;
  if(request.method==='GET')return path===inboxPath||organizationInvitations.test(path)||organizationMembers.test(path)||projectMembers.test(path);
  if(request.method==='POST')return organizationInvitations.test(path)||revokePath.test(path)||acceptPath.test(path)||projectMembers.test(path);
  return false;
}

export async function handleMemberRequest(pool:Pool,principal:IdentityPrincipal,request:Request):Promise<unknown>{
  const path=new URL(request.url).pathname;
  if(path===inboxPath&&request.method==='GET')return listRecipientInvitations(pool,principal.id);
  let match=organizationInvitations.exec(path);
  if(match){
    const organizationId=uuid.parse(match[1]);
    if(request.method==='GET')return listOrganizationInvitations(pool,principal.id,organizationId);
    const input=invitationSchema.parse(await readBoundedJson(request));
    return issueInvitation(pool,principal.id,organizationId,input.email,input.requestId);
  }
  match=revokePath.exec(path);
  if(match){emptySchema.parse(await readBoundedJson(request));return revokeInvitation(pool,principal.id,uuid.parse(match[1]),uuid.parse(match[2]));}
  match=acceptPath.exec(path);
  if(match){emptySchema.parse(await readBoundedJson(request));return acceptInvitation(pool,principal,uuid.parse(match[1]));}
  match=organizationMembers.exec(path);
  if(match)return listOrganizationMembers(pool,principal.id,uuid.parse(match[1]));
  match=projectMembers.exec(path);
  if(match){
    const projectId=uuid.parse(match[1]);
    if(request.method==='GET')return listProjectMembers(pool,principal.id,projectId);
    return changeProjectMember(pool,principal.id,projectId,projectMemberSchema.parse(await readBoundedJson(request)));
  }
  throw 404;
}
