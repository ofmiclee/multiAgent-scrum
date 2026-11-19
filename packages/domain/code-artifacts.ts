import {createHash} from 'node:crypto';
import {z} from 'zod';
export {codeManifestRefSchema,type CodeManifestRef} from './code-result-artifacts.ts';
import {assertSafeCodeContent,assertSafeCodePath,repositorySnapshotSchema} from './code-transfer.ts';

export const PORTABLE_ARTIFACT_MAX_BYTES=48*1024*1024;
export const PORTABLE_ARTIFACT_CHUNK_MAX_BYTES=256*1024;
const sha256=z.string().regex(/^[a-f0-9]{64}$/);
export const storedBytesSchema=z.object({
  sha256,
  sizeBytes:z.number().int().min(1).max(PORTABLE_ARTIFACT_MAX_BYTES),
}).strict();

export const repositoryArchiveRefSchema=z.object({
  schema:z.literal(1),
  kind:z.literal('repository-snapshot'),
  repository:repositorySnapshotSchema,
  object:storedBytesSchema,
}).strict();


export type RepositoryArchiveRef=z.infer<typeof repositoryArchiveRefSchema>;

const entrySchema=z.object({
  path:z.string(),content:z.string(),executable:z.boolean(),hash:sha256,
}).strict();
const treeSchema=z.object({schema:z.literal(1),kind:z.literal('tree'),entries:z.array(entrySchema).max(2000)}).strict();
const repositoryObjectSchema=z.object({
  schema:z.literal(1),kind:z.literal('repository'),commit:z.string(),createdAt:z.string(),treeId:sha256,fileCount:z.number().int(),
}).strict();
const archiveSchema=z.object({schema:z.literal(1),kind:z.literal('repository-snapshot'),repository:repositoryObjectSchema,tree:treeSchema}).strict();
export type ValidatedRepositoryArchive=z.infer<typeof archiveSchema>;

const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');

/** Pure validation for server intake and SnapshotStore import. It writes nothing. */
export function validateRepositoryArchiveBytes(rawRef:RepositoryArchiveRef,bytes:Buffer):ValidatedRepositoryArchive{
  const checkedRef=repositoryArchiveRefSchema.safeParse(rawRef);
  if(!checkedRef.success)throw Error('Repository archive reference size or schema invalid');
  const ref=checkedRef.data;
  if(!Buffer.isBuffer(bytes)||bytes.length>PORTABLE_ARTIFACT_MAX_BYTES)throw Error('Repository archive size limit exceeded');
  if(bytes.length!==ref.object.sizeBytes||digest(bytes)!==ref.object.sha256)throw Error('Repository archive integrity mismatch');
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes))throw Error('Repository archive is not valid UTF-8');
  let raw:unknown;
  try{raw=JSON.parse(text);}catch{throw Error('Repository archive invalid JSON');}
  const checkedArchive=archiveSchema.safeParse(raw);
  if(!checkedArchive.success)throw Error('Repository archive invalid schema');
  const parsed=checkedArchive.data,entries=parsed.tree.entries;
  let total=0;
  const files=new Set<string>(),prefixes=new Map<string,string>(),directories=new Set<string>(['']);
  for(const entry of entries){
    assertSafeCodePath(entry.path);
    const folded=entry.path.toLowerCase();
    if(files.has(folded))throw Error('Repository archive duplicate or aliased path');
    if(directories.has(folded))throw Error('Repository archive file directory conflict');
    files.add(folded);
    if(entry.content.length>Math.ceil((2*1024*1024)/3)*4)throw Error('Repository archive file size limit exceeded');
    const content=Buffer.from(entry.content,'base64');
    if(content.toString('base64')!==entry.content||content.length>2*1024*1024||
      digest(Buffer.concat([Buffer.from(entry.executable?'x\0':'-\0'),content]))!==entry.hash)throw Error('Repository archive entry integrity mismatch');
    total+=content.length;if(total>32*1024*1024)throw Error('Repository archive decoded size limit exceeded');
    assertSafeCodeContent(content);
    const parts=entry.path.split('/');
    for(let n=1;n<=parts.length;n++){
      const prefix=parts.slice(0,n).join('/'),key=prefix.toLowerCase();
      if(prefixes.has(key)&&prefixes.get(key)!==prefix)throw Error('Repository archive path case conflict');
      prefixes.set(key,prefix);
      if(n<parts.length){
        if(files.has(key))throw Error('Repository archive file directory conflict');
        directories.add(key);if(directories.size>2000)throw Error('Repository archive directory count limit exceeded');
      }
    }
  }
  for(const path of files){
    const parts=path.split('/');parts.pop();
    while(parts.length){if(files.has(parts.join('/')))throw Error('Repository archive file directory conflict');parts.pop();}
  }
  const repository={schema:1 as const,kind:'repository' as const,commit:parsed.repository.commit,createdAt:parsed.repository.createdAt,treeId:parsed.repository.treeId,fileCount:parsed.repository.fileCount};
  const tree={schema:1 as const,kind:'tree' as const,entries};
  const archive={schema:1 as const,kind:'repository-snapshot' as const,repository,tree};
  if(JSON.stringify(archive)!==text)throw Error('Repository archive serialization mismatch');
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(repository.commit)||!Number.isFinite(Date.parse(repository.createdAt))||
    repository.fileCount!==entries.length||digest(JSON.stringify(tree))!==repository.treeId||digest(JSON.stringify(repository))!==ref.repository.id||
    repository.commit!==ref.repository.commit||repository.createdAt!==ref.repository.createdAt||repository.fileCount!==ref.repository.fileCount)
    throw Error('Repository archive metadata mismatch');
  return archive;
}
