import {z} from 'zod';
export const projectRole=z.enum(['owner','manager','member','viewer']);
export const organizationSchema=z.object({id:z.uuid(),name:z.string(),role:z.string(),slug:z.string().nullable(),alias:z.string().nullable(),description:z.string().nullable(),version:z.number().int().positive(),image:z.string().nullable()}).strict();
export const projectSchema=z.object({id:z.uuid(),organizationId:z.uuid(),name:z.string(),key:z.string().nullable(),description:z.string().nullable(),version:z.number().int().positive(),role:projectRole,defaultBoardId:z.uuid()}).strict();
export const roleLabel={owner:'项目负责人',manager:'项目经理',member:'成员',viewer:'只读成员'};
