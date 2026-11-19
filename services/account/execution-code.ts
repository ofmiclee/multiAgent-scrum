import type {PoolClient} from 'pg';
import {codeInputSchema,codeBundleSchema,codeManifest,validateCodeComposition,type CodeBinding,type CodeInput,type CodeBundle} from '../../packages/domain/code-transfer.ts';
import {detachedCodeResultSchema,type DetachedCodeResult} from '../../packages/domain/code-result-artifacts.ts';
import {PORTABLE_ARTIFACT_MAX_BYTES} from '../../packages/domain/code-artifacts.ts';
import type {ArtifactStorage} from './artifact-store.ts';
import {resolveCodeArtifact} from './code-result-artifacts.ts';

/** Read accepted ancestry from authoritative work rows; polling never supplies patches. */
export async function assignedCode(client:PoolClient,taskId:string,binding:CodeBinding,store?:ArtifactStorage):Promise<CodeInput>{
  const result=await client.query<{id:string;project_id:string;status:string;position:number;required_capabilities:string[];dependencies:string[];result:{code?:CodeBundle;codeArtifact?:DetachedCodeResult}|null;code_context:CodeInput|null}>(`WITH RECURSIVE ancestors(id) AS (
    SELECT depends_on_id FROM mas_business_task_dependency WHERE task_id=$1
    UNION SELECT d.depends_on_id FROM mas_business_task_dependency d JOIN ancestors a ON a.id=d.task_id
  ) SELECT t.id,t.project_id,t.status,t.position,t.required_capabilities,w.result,a.code_context,
    ARRAY(SELECT d.depends_on_id FROM mas_business_task_dependency d WHERE d.task_id=t.id ORDER BY d.depends_on_id) AS dependencies
    FROM ancestors x JOIN mas_business_task t ON t.id=x.id
    LEFT JOIN mas_business_work w ON w.task_id=t.id AND w.kind='execute' AND w.state='done'
    LEFT JOIN mas_business_work_attempt a ON a.work_id=w.id AND a.state='finished' AND a.fence=w.calls
    ORDER BY t.position,t.id`,[taskId]);
  const rows=new Map(result.rows.map(row=>[row.id,row])),visiting=new Set<string>(),visited=new Set<string>(),dependencies:CodeInput['dependencies']=[],resolved:CodeBundle[]=[];
  async function visit(id:string){
    if(visited.has(id))return;if(visiting.has(id)||id===taskId)throw 409;
    const row=rows.get(id);if(!row||row.project_id!==binding.projectId||row.status!=='done'||!row.result)throw 409;
    visiting.add(id);for(const parent of row.dependencies)await visit(parent);
    if(row.required_capabilities.includes('coding')){
      const parsedContext=codeInputSchema.safeParse(row.code_context);
      if(!parsedContext.success||Boolean(row.result.code)===Boolean(row.result.codeArtifact))throw 409;
      const detached=row.result.codeArtifact?detachedCodeResultSchema.parse(row.result.codeArtifact):undefined;
      if(detached&&!store)throw 409;
      const code=detached?await resolveCodeArtifact(client,store!,detached,binding.projectId):codeBundleSchema.parse(row.result.code),context=parsedContext.data;
      if(context.projectId!==binding.projectId||!sameRepository(context.repository,binding.repository)||code.repositorySnapshotId!==binding.repository.id)throw 409;
      dependencies.push(detached??code);resolved.push(code);
    }
    visiting.delete(id);visited.add(id);
  }
  for(const row of result.rows)await visit(row.id);
  try{validateCodeComposition(resolved,PORTABLE_ARTIFACT_MAX_BYTES);}catch{throw 409;}
  return codeInputSchema.parse({...binding,dependencies});
}
function sameRepository(a:CodeBinding['repository'],b:CodeBinding['repository']){
  return a.id===b.id&&a.commit===b.commit&&a.fileCount===b.fileCount&&a.createdAt===b.createdAt;
}
export function codeArtifacts(code:CodeBundle){
  const changes=codeManifest(code).changes;
  const review=changes.map(c=>{
    const label=`${c.before===null?'ADDED':c.after===null?'DELETED':'MODIFIED'} ${c.path}\nBefore hash: ${c.before??'(absent)'}\n`;
    if(!c.after)return label+'File deleted.\n';
    const bytes=Buffer.from(c.after.content,'base64'),text=bytes.toString('utf8');
    const binary=!Buffer.from(text,'utf8').equals(bytes)||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
    return label+`After hash: ${c.after.hash}\nExecutable: ${c.after.executable}\n`+(binary?`Binary file (${bytes.length} bytes); exact base64 content is in code-manifest.json.\n`:'Complete resulting file text:\n'+text+'\n');
  }).join('\n');
  if(Buffer.byteLength(review)>64*1024)throw 413;
  return [{name:'code-changes.txt',content:`${changes.length} changed file(s)\nRepository: ${code.repositorySnapshotId}\nInput: ${code.inputSnapshotId}\nChanges: ${code.changesId}\n`+changes.map(c=>`${c.before===null?'added':c.after===null?'deleted':'modified'} ${c.path}`).join('\n')},
    {name:'code-review.txt',content:review},
    {name:'code-manifest.json',content:code.manifest}];
}
