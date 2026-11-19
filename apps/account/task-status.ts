import {z} from 'zod';
export const taskStatusSchema=z.enum(['pending','assigned','running','review','done','failed']);
export const taskStatusLabel={pending:'待领取',assigned:'已分配',running:'执行中',review:'待验收',done:'已完成',failed:'执行失败'} as const;
