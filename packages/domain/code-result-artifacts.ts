import {z} from 'zod';
const sha256=z.string().regex(/^[a-f0-9]{64}$/);
export const codeManifestRefSchema=z.object({
  schema:z.literal(1),kind:z.literal('code-changes'),repositorySnapshotId:sha256,inputSnapshotId:sha256,changesId:sha256,
  object:z.object({sha256,sizeBytes:z.number().int().min(1).max(48*1024*1024)}).strict(),
}).strict().superRefine((value,ctx)=>{if(value.changesId!==value.object.sha256)ctx.addIssue({code:'custom',message:'Code artifact identity mismatch'});});
export type CodeManifestRef=z.infer<typeof codeManifestRefSchema>;
export const detachedCodeResultSchema=z.object({uploadId:z.uuid(),ref:codeManifestRefSchema}).strict();
export type DetachedCodeResult=z.infer<typeof detachedCodeResultSchema>;
