import {createHash} from 'node:crypto';
import {z} from 'zod';
import {detachedCodeResultSchema,type DetachedCodeResult} from './code-result-artifacts.ts';

const sha256=z.string().regex(/^[a-f0-9]{64}$/);
export const repositorySnapshotSchema=z.object({id:sha256,commit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),fileCount:z.number().int().min(0).max(2000),createdAt:z.iso.datetime()}).strict();
export const codeBindingSchema=z.object({projectId:z.uuid().transform(v=>v.toLowerCase()),repository:repositorySnapshotSchema}).strict();
const bundleShape=z.object({repositorySnapshotId:sha256,inputSnapshotId:sha256,changesId:sha256,manifest:z.string().max(32768)}).strict();
const entrySchema=z.object({path:z.string(),content:z.string(),executable:z.boolean(),hash:sha256}).strict();
const manifestSchema=z.object({schema:z.literal(1),kind:z.literal('changes'),repositorySnapshotId:sha256,
  changes:z.array(z.object({path:z.string(),before:sha256.nullable(),after:entrySchema.nullable()}).strict()).max(4000)}).strict();
export type CodeManifest=z.infer<typeof manifestSchema>;
export type CodeBundle=z.infer<typeof bundleShape>;
export type CodeBinding=z.infer<typeof codeBindingSchema>;
export type CodeDependency=CodeBundle|DetachedCodeResult;
export type CodeInput=CodeBinding&{dependencies:CodeDependency[]};
const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const excluded=new Set(['.git','node_modules','.runtime','dist','build','.next','.cache','coverage']);
export function assertSafeCodePath(path:string){
  if(!path||Buffer.byteLength(path)>512||/[\\\x00-\x1f\x7f:]/.test(path)||path.normalize('NFC')!==path||path.split('/').length>63)throw Error('Unsafe code path');
  for(const part of path.split('/')){
    const p=part.toLowerCase();
    if(!p||p==='.'||p==='..'||/[. ]$/.test(p)||excluded.has(p))throw Error('Excluded or unsafe code path');
    if(p!=='.env.example'&&p!=='.env.sample'&&(p==='.env'||p.startsWith('.env.')||p.endsWith('.env')||/^(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.|$)/.test(p)||/\.(pem|key|p12|pfx|keystore)$/.test(p)||['.npmrc','.netrc','.pypirc','.aws','.ssh','.gnupg','credentials','credentials.json','service-account.json'].includes(p)))throw Error('Sensitive code path');
  }
}
export function assertSafeCodeContent(bytes:Buffer){
  const text=bytes.toString('utf8');
  if(/-----BEGIN [^-]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[A-Za-z0-9._~-]{12,}|postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/i.test(text)||/["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key)["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/i.test(text))throw Error('Code contains possible secret material');
}
/** Preserve the exact SnapshotStore Changes serialization and mode-prefixed entry hashes. */
export function codeManifest(bundle:CodeBundle):CodeManifest{
  return validateCodeManifestBytes(bundle.manifest,bundle.repositorySnapshotId,bundle.changesId,32768);
}
/** Detached artifacts retain the same validation while using an explicitly supplied byte cap. */
export function validateCodeManifestBytes(manifestBytes:string|Buffer,repositorySnapshotId:string,changesId:string,maxBytes:number):CodeManifest{
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw Error('Invalid code manifest limit');
  const bytes=Buffer.isBuffer(manifestBytes)?manifestBytes:Buffer.from(manifestBytes,'utf8');
  if(bytes.length>maxBytes)throw Error(maxBytes===32768?'Code manifest exceeds 32 KiB':'Code manifest exceeds portable artifact limit');
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes))throw Error('Code manifest is not valid UTF-8');
  if(digest(bytes)!==changesId)throw Error('Code manifest integrity mismatch');
  const raw=JSON.parse(text),manifest=manifestSchema.parse(raw);
  // SnapshotStore.save reserializes objects, so only round-trippable exact JSON is transferable.
  if(JSON.stringify(raw)!==text||manifest.repositorySnapshotId!==repositorySnapshotId)throw Error('Code repository or serialization mismatch');
  const paths=new Set<string>();let total=0,materialized=0;
  for(const change of manifest.changes){
    assertSafeCodePath(change.path);
    if(paths.has(change.path))throw Error('Duplicate code path');paths.add(change.path);
    if(change.before===(change.after?.hash??null))throw Error('Code change has no delta');
    if(change.after){
      if(++materialized>2000)throw Error('Code materialized file count limit exceeded');
      const entry=change.after;
      if(entry.content.length>Math.ceil((2*1024*1024)/3)*4)throw Error('Code file size limit exceeded');
      const bytes=Buffer.from(entry.content,'base64');
      if(entry.path!==change.path||bytes.toString('base64')!==entry.content||digest(Buffer.concat([Buffer.from(entry.executable?'x\0':'-\0'),bytes]))!==entry.hash)throw Error('Code entry integrity mismatch');
      if(bytes.length>2*1024*1024||(total+=bytes.length)>32*1024*1024)throw Error('Code file or decoded total size limit exceeded');
      assertSafeCodeContent(bytes);
    }
  }
  compatiblePaths(manifest.changes.filter(c=>c.after).map(c=>c.path));
  // Retain original key order as well as values: SnapshotStore.save hashes JSON.stringify.
  return raw as CodeManifest;
}
function compatiblePaths(paths:string[]){
  const files=new Set(paths.map(path=>path.toLowerCase())),prefixes=new Map<string,string>(),directories=new Set(['']);
  for(const path of paths){
    const parts=path.split('/');
    for(let n=1;n<=parts.length;n++){
      const prefix=parts.slice(0,n).join('/'),folded=prefix.toLowerCase();
      if(prefixes.has(folded)&&prefixes.get(folded)!==prefix)throw Error('Code path case conflict');
      prefixes.set(folded,prefix);
      if(n<parts.length&&files.has(folded))throw Error('Code file directory conflict');
      if(n<parts.length){
        directories.add(folded);
        if(directories.size>2000)throw Error('Code directory count limit exceeded');
      }
    }
  }
}
/** Validate each composed intermediate tree, matching SnapshotStore's atomic bundle application. */
export function validateCodeComposition(bundles:CodeBundle[],maxBytes=32768){
  const current=new Map<string,string|null>(),applied=new Set<string>();
  for(const bundle of bundles){
    const manifest=validateCodeManifestBytes(bundle.manifest,bundle.repositorySnapshotId,bundle.changesId,maxBytes);
    if(applied.has(bundle.changesId))continue;
    for(const change of manifest.changes){
      const next=change.after?.hash??null;
      if(current.has(change.path)&&current.get(change.path)!==change.before&&current.get(change.path)!==next)throw Error('Dependency code change conflict');
      current.set(change.path,next);
    }
    compatiblePaths([...current].filter(([,hash])=>hash!==null).map(([path])=>path));
    applied.add(bundle.changesId);
  }
}
export const codeBundleSchema=bundleShape.superRefine((bundle,ctx)=>{try{codeManifest(bundle);}catch{ctx.addIssue({code:'custom',message:'Invalid, unsafe, or oversized code manifest'});}});
export function validateCodeBundle(value:unknown):CodeBundle{return codeBundleSchema.parse(value);}
export const codeInputSchema=codeBindingSchema.extend({dependencies:z.array(z.union([codeBundleSchema,detachedCodeResultSchema])).max(2000)}).strict();
