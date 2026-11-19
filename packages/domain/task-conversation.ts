import {z} from 'zod';

export const CONVERSATION_MAX_BYTES=48*1024;
export const conversationEntrySchema=z.object({
  id:z.string().min(1).max(160),kind:z.enum(['message','tool']),text:z.string().max(4000),
  state:z.enum(['running','completed','failed']),at:z.number().int().nonnegative().safe(),
}).strict();
export const conversationSnapshotSchema=z.object({
  revision:z.number().int().positive().safe(),entries:z.array(conversationEntrySchema).max(80),truncated:z.boolean(),
}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=CONVERSATION_MAX_BYTES,'Conversation snapshot too large');
export type ConversationEntry=z.infer<typeof conversationEntrySchema>;
export type ConversationSnapshot=z.infer<typeof conversationSnapshotSchema>;
export const taskConversationResponseSchema=z.object({
  identityId:z.string(),projectId:z.uuid(),taskId:z.uuid(),
  taskStatus:z.enum(['pending','assigned','running','review','done','failed']),
  attempt:z.object({
    id:z.uuid(),state:z.enum(['assigned','running','finished','stopped']),agentName:z.string(),live:z.boolean(),
    updatedAt:z.iso.datetime().nullable(),snapshot:conversationSnapshotSchema.nullable(),
  }).strict().nullable(),
}).strict();

export const taskMessageSchema=z.object({
  id:z.uuid(),authorName:z.string(),body:z.string().max(2000),
  state:z.enum(['queued','delivering','delivered','rejected','unknown']),createdAt:z.iso.datetime(),
  error:z.enum(['execution_ended','permission_revoked','rejected','unconfirmed']).nullable(),
}).strict();
export const taskMessageInputSchema=z.object({
  identityId:z.string().min(1).max(128),attemptId:z.uuid(),requestId:z.uuid(),body:z.string().trim().min(1).max(2000),
}).strict();
export const taskMessageReceiptSchema=z.object({
  identityId:z.string(),projectId:z.uuid(),taskId:z.uuid(),attemptId:z.uuid(),message:taskMessageSchema,
}).strict();
export const taskInteractiveConversationResponseSchema=taskConversationResponseSchema.extend({
  messaging:z.object({canSend:z.boolean(),reason:z.enum(['read_only','not_running','offline','unavailable','unsupported','limit']).nullable(),messages:z.array(taskMessageSchema).max(50)}).strict(),
}).strict();
export const runnerTaskMessageResponseSchema=z.object({
  attemptId:z.uuid(),message:z.object({id:z.uuid(),text:z.string().min(1).max(2000)}).strict().nullable(),
}).strict();
