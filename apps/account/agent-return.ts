import {z} from 'zod';
import {modelChoiceSchema} from '../../packages/domain/agent-models';

const profile=z.enum(['demo','dsh-text','codex-code']);
const values={name:z.string().max(120),instructions:z.string().max(4000),model:modelChoiceSchema.optional(),credentialId:z.union([z.literal(''),z.literal('legacy'),z.uuid()]).optional()};
const pending=z.object({key:z.string().max(30000),requestId:z.uuid(),input:z.union([
  z.object({...values,sourceAgentId:z.uuid()}).strict(),
  z.object({...values,runnerId:z.uuid(),profile}).strict(),
])}).strict().nullable();
export const agentDraftSchema=z.object({...values,runnerId:z.union([z.literal(''),z.uuid()]),profile,pending,projectContext:z.object({organizationId:z.uuid(),projectId:z.uuid()}).strict().optional()}).strict();
const draft=agentDraftSchema;
const record=z.object({identityId:z.string(),intentId:z.uuid(),expiresAt:z.number(),draft}).strict();
export type AgentDraft=z.infer<typeof draft>;
const prefix='mas.agent-return.';
const key=(identityId:string,intentId:string)=>prefix+identityId+'.'+intentId;

export function agentDraftId(hash:string):string|null{
  const id=z.uuid().safeParse(/^#agent-create=([^&]+)$/.exec(hash)?.[1]);
  return id.success?id.data.toLowerCase():null;
}

// Navigation/draft hints only: no launch ticket, device credential or grant is stored.
export function readAgentReturn(identityId:string,intentId:string):AgentDraft|null{
  try{
    const value=record.safeParse(JSON.parse(localStorage.getItem(key(identityId,intentId))??'null'));
    if(!value.success||value.data.identityId!==identityId||value.data.intentId!==intentId||value.data.expiresAt<=Date.now()){
      localStorage.removeItem(key(identityId,intentId));return null;
    }
    return value.data.draft;
  }catch{return null;}
}
export function saveAgentReturn(identityId:string,intentId:string,values:AgentDraft){
  try{localStorage.setItem(key(identityId,intentId),JSON.stringify(record.parse({identityId,intentId,expiresAt:Date.now()+24*60*60_000,draft:values})));}catch{/* Optional browser storage; authorization always remains server-side. */}
}
export function clearAgentReturn(identityId:string,intentId:string){
  try{localStorage.removeItem(key(identityId,intentId));}catch{/* Storage may be unavailable. */}
  if(window.location.hash==='#runner-connect='+intentId||window.location.hash==='#agent-create='+intentId)window.history.replaceState(null,'',window.location.pathname+window.location.search+'#agents');
}
export function clearAgentReturns(identityId:string){
  try{for(const item of Object.keys(localStorage))if(item.startsWith(prefix+identityId+'.'))localStorage.removeItem(item);}catch{/* Storage may be unavailable. */}
}
