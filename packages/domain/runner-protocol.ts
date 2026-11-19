import {z} from 'zod';
import {codeInputSchema,codeBundleSchema} from './code-transfer.ts';
import {modelIdSchema} from './agent-models.ts';
import {detachedCodeResultSchema} from './code-result-artifacts.ts';
import {typeSafeEvaluationSchema} from './typesafe-assessment.ts';
import {executionFailureReasonSchema} from './execution-errors.ts';
export const runnerProfileSchema=z.enum(['demo','dsh-text','codex-code']);
export type RunnerProfile=z.infer<typeof runnerProfileSchema>;
export const runnerCredentialSchema=z.object({id:z.union([z.literal('legacy'),z.uuid()]),profile:z.enum(['dsh-text','codex-code']),kind:z.enum(['subscription','api-key']),label:z.string().trim().min(1).max(80).refine(value=>!/@|\b(?:sk|ds|key)[-_][A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{32,}/i.test(value))}).strict();
export type RunnerCredential=z.infer<typeof runnerCredentialSchema>;
export const taskRefSchema=z.object({taskId:z.string().min(1).max(100),attemptId:z.string().min(1).max(100),fence:z.number().int().positive().max(16)}).strict();
export type TaskRef=z.infer<typeof taskRefSchema>;
export const remoteInputSchema=taskRefSchema.extend({purpose:z.enum(['assess','decompose']).optional(),model:modelIdSchema.optional(),credentialId:z.union([z.literal('legacy'),z.uuid()]).optional(),title:z.string().max(200),description:z.string().max(20000),acceptance:z.string().max(20000),feedback:z.array(z.string().max(20000)).max(20),code:codeInputSchema.optional()}).strict().refine(input=>!input.purpose||!input.code,{message:'Coordination cannot contain code input'});
export const remoteResultSchema=z.object({summary:z.string().max(16000),artifacts:z.array(z.object({name:z.string().min(1).max(160),content:z.string().max(16000)}).strict()).max(3),checksPassed:z.literal(false),nativeSession:z.object({threadId:z.string().min(1).max(200),turnId:z.string().min(1).max(200)}).strict().optional(),code:codeBundleSchema.optional(),codeArtifact:detachedCodeResultSchema.optional(),assessmentEvaluation:typeSafeEvaluationSchema.optional()}).strict().refine(result=>!(result.code&&result.codeArtifact),{message:'Code result must use one transport'}).refine(result=>!result.assessmentEvaluation||(!result.nativeSession&&!result.code&&!result.codeArtifact),{message:'TypeSafe assessment is separate from native execution'});
export type RemoteResult=z.infer<typeof remoteResultSchema>;
export const terminalSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('result'),result:remoteResultSchema}).strict(),
  z.object({kind:z.literal('stopped'),reason:executionFailureReasonSchema.optional()}).strict(),
]);
export type TaskTerminal=z.infer<typeof terminalSchema>;
