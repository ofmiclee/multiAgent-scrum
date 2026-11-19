import {z} from 'zod';

export const modelIdSchema=z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export const modelChoiceSchema=modelIdSchema.nullable().default(null);
export const modelDirectoryEntrySchema=z.object({
  vendor:z.string().min(1).max(40),profile:z.enum(['dsh-text','codex-code']),model:modelIdSchema,
  displayName:z.string().min(1).max(120),difficultyMin:z.number().int().min(1).max(5),
  difficultyMax:z.number().int().min(1).max(5),relativeCost:z.number().int().min(1).max(3),isDefault:z.boolean(),
}).strict().refine(entry=>entry.difficultyMax>=entry.difficultyMin);
export const modelDirectorySchema=z.array(modelDirectoryEntrySchema);
export type ModelDirectoryEntry=z.infer<typeof modelDirectoryEntrySchema>;

export type ModelRoutingDefaults={difficultyMin:1;difficultyMax:1|2|3|4|5;relativeCost:1|2|3};

/** Model-based starting point for routing policy; users can still override it. */
export function modelRoutingDefaults(model:string|null|undefined):ModelRoutingDefaults{
  const value=(model??'').toLocaleLowerCase();
  if(/(?:gpt-6-astra|\bastra\b)/.test(value))return {difficultyMin:1,difficultyMax:5,relativeCost:3};
  if(/(?:mini|flash|nano|haiku|luna|fast)/.test(value))return {difficultyMin:1,difficultyMax:3,relativeCost:1};
  if(/(?:gpt-6-sol|gpt-5\.6-sol|gpt-5\.5|deepseek-v4-pro)/.test(value))return {difficultyMin:1,difficultyMax:5,relativeCost:2};
  if(/(?:pro|max|opus|o[134]|gpt-5\.2)/.test(value))return {difficultyMin:1,difficultyMax:5,relativeCost:3};
  return {difficultyMin:1,difficultyMax:4,relativeCost:2};
}
