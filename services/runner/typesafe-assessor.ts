import type {ExecutionInput,ExecutionResult,Executor} from '../../packages/domain/contracts.ts';
import {assessmentQuestions,assessmentRubricVersion,typeSafeResponseSchema,assessmentFromTypeSafe} from '../../packages/domain/typesafe-assessment.ts';
import {assessmentInputHash,typeSafeAssessmentEvidence} from '../../packages/domain/typesafe-assessment-hash.ts';

export type TypeSafeConfig={apiKey:string;model:string};
export function typeSafeConfig(environment:NodeJS.ProcessEnv):TypeSafeConfig|undefined{
  const provider=environment.MAS_TASK_ASSESSOR??'coordinator';
  if(provider==='coordinator')return;
  if(provider!=='typesafe')throw Error('MAS_TASK_ASSESSOR must be coordinator or typesafe');
  const apiKey=environment.TYPESAFE_API_KEY,model=environment.TYPESAFE_MODEL??'jev-latest';
  if(!apiKey||apiKey.length>4096||/[\s\p{Cc}]/u.test(apiKey))throw Error('TYPESAFE_API_KEY is required for TypeSafe assessment');
  if(!/^[a-zA-Z0-9._-]{1,120}$/.test(model))throw Error('Invalid TYPESAFE_MODEL');
  return {apiKey,model};
}

export class TypeSafeAssessor implements Executor {
  constructor(private fallback:Executor,private config:TypeSafeConfig,private request:typeof fetch=fetch){}
  async run(input:ExecutionInput,signal:AbortSignal):Promise<ExecutionResult>{
    if(input.purpose!=='assess')return this.fallback.run(input,signal);
    if(input.code)throw Error('TypeSafe assessment cannot contain code execution input');
    signal.throwIfAborted();
    const body=JSON.stringify({model:this.config.model,state:{task:typeSafeAssessmentEvidence(input)},questions:assessmentQuestions});
    if(Buffer.byteLength(body)>96*1024)throw Error('TypeSafe assessment input exceeds its limit');
    const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(20_000)]);
    try{
      const response=await this.request('https://api.typesafe.ai/v1/systemone',{
        method:'POST',redirect:'error',signal:requestSignal,
        headers:{Authorization:`Bearer ${this.config.apiKey}`,'Content-Type':'application/json'},body,
      });
      if(!response.ok){await response.body?.cancel();throw Error('TypeSafe request failed');}
      if(!response.body)throw Error('TypeSafe response is empty');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];
      let length=0;
      try{
        for(;;){
          const part=await reader.read();if(part.done)break;
          length+=part.value.length;
          if(length>24*1024)throw Error('TypeSafe response exceeds its limit');
          chunks.push(part.value);
        }
      }finally{await reader.cancel();reader.releaseLock();}
      requestSignal.throwIfAborted();
      const parsed=typeSafeResponseSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const assessmentEvaluation={provider:'typesafe' as const,rubricVersion:assessmentRubricVersion,inputHash:assessmentInputHash(input),response:parsed};
      const assessment=assessmentFromTypeSafe(assessmentEvaluation);
      return {summary:assessment?JSON.stringify(assessment):'TypeSafe：当前执行能力无法匹配此任务，请修订任务范围。',artifacts:[],checksPassed:false,assessmentEvaluation};
    }catch{
      // No provider body, task content or credential may leak through diagnostics.
      // Failure follows the existing stopped-attempt / Owner-resume workflow.
      throw Error(requestSignal.aborted?'TypeSafe assessment cancelled or timed out':'TypeSafe assessment failed; check credentials, quota and service availability');
    }
  }
}
