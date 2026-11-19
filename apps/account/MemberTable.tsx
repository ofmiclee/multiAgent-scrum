import {z} from 'zod';
export const memberSchema=z.object({id:z.uuid(),name:z.string(),role:z.string(),status:z.enum(['active','suspended']),version:z.number().int().positive(),joinedAt:z.string().nullable().optional(),invitedBy:z.string().nullable().optional()}).strict();
export const membersSchema=z.object({members:z.array(memberSchema)}).strict();
export function joinedDate(value?:string|null){return value?new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium'}).format(new Date(value)):'—';}
export function MemberName({name}:{name:string}){return <span className="member-name"><span className="member-avatar" aria-hidden="true">{Array.from(name)[0]}</span><strong title={name}>{name}</strong></span>;}
