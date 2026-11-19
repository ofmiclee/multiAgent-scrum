import {z} from 'zod';

/** Shared wire schema: safe in both the Web bundle and the server. */
export const assessmentSchema=z.object({
  difficulty:z.number().int().min(1).max(5),risk:z.enum(['low','medium','high']),
  confidence:z.number().min(0).max(1),rationale:z.string().trim().min(1).max(2000),
  requiredCapability:z.enum(['coding','writing']),
}).strict();
