import {z} from 'zod';

export const publicationUuid=z.uuid().transform(value=>value.toLowerCase());
const key=z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
const taskSchema=z.object({
  key,title:z.string().trim().min(1).max(200).refine(value=>!value.includes('\0')),
  objective:z.string().trim().min(1).max(4000).refine(value=>!value.includes('\0')),
  acceptanceCriteria:z.string().trim().min(1).max(4000).refine(value=>!value.includes('\0')),
  requiredCapabilities:z.array(key).min(1).max(10).refine(values=>new Set(values).size===values.length),
  priority:z.enum(['low','normal','high']),
  dependsOn:z.array(key).max(19).refine(values=>new Set(values).size===values.length),
}).strict();

export const publicationInput=z.object({
  expectedVersion:z.number().int().min(1).max(2147483647),
  requestId:publicationUuid,tasks:z.array(taskSchema).min(1).max(20),
}).strict().superRefine((input,ctx)=>{
  const graph=new Map(input.tasks.map(task=>[task.key,task.dependsOn]));
  const reject=()=>ctx.addIssue({code:'custom',message:'Task dependencies must be a unique, closed acyclic graph',path:['tasks']});
  if(graph.size!==input.tasks.length){reject();return;}
  const visiting=new Set<string>(),visited=new Set<string>();
  function visit(key:string):boolean{
    if(visited.has(key))return true;
    if(visiting.has(key)||!graph.has(key))return false;
    visiting.add(key);
    for(const dependency of graph.get(key)!)if(!visit(dependency))return false;
    visiting.delete(key);visited.add(key);return true;
  }
  if(input.tasks.some(task=>!visit(task.key)))reject();
});
export type PublicationInput=z.infer<typeof publicationInput>;
