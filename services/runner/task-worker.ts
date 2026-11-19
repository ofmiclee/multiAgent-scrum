import {z} from 'zod';
import {taskRefSchema,remoteInputSchema,remoteResultSchema,runnerProfileSchema,type RunnerProfile,type RunnerCredential,type TaskRef,type TaskTerminal} from '../../packages/domain/runner-protocol.ts';
import {codeBindingSchema,type CodeBinding} from '../../packages/domain/code-transfer.ts';
import type {Executor,ExecutionResult,ExecutionMessageHandler,ExecutionMessageOutcome} from '../../packages/domain/contracts.ts';
import {ExecutorStopUnconfirmed,ExecutorTimeout} from '../../packages/domain/execution-errors.ts';
import type {DeviceIdentity} from './device-identity.ts';
import {TaskJournal} from './task-journal.ts';
import {localDeviceServer,sendDeviceRequest,DeviceResponseError,DeviceWorkBlocked} from './device-client.ts';
import {conversationEntrySchema,runnerTaskMessageResponseSchema,CONVERSATION_MAX_BYTES,type ConversationSnapshot,type ConversationEntry} from '../../packages/domain/task-conversation.ts';
import {redactText} from './results.ts';

type Progress={snapshot:ConversationSnapshot;sentRevision:number;disabled?:boolean;upload?:Promise<void>};
type Messages={controller:AbortController;handler?:ExecutionMessageHandler;inflight?:Promise<void>;disabled?:boolean;closing?:boolean;
  receipt?:{messageId:string;outcome:ExecutionMessageOutcome};sent:Map<string,Promise<ExecutionMessageOutcome>>};
type Active={ref:TaskRef;controller:AbortController;timer:NodeJS.Timeout;promise:Promise<void>;terminal?:TaskTerminal;broken?:boolean;progress?:Progress;messages?:Messages};
type Preparation={sessionId:string;controller:AbortController;promise:Promise<void>;ready:boolean;failed:boolean;error?:unknown};
export type WorkerProvider={profile:RunnerProfile;executor:Executor;accepting?:()=>boolean;credentials?:()=>RunnerCredential[];codeBindings?:CodeBinding[];prepare?:(sessionId:string,signal:AbortSignal)=>Promise<void>};
const FINISH_BODY_LIMIT=96*1024;
function clipText(text:string,bytes:number,marker='\n[输出已截断：文本传输上限]'){
    const value=Buffer.from(text);
    return value.length<=bytes?text:value.subarray(0,bytes-Buffer.byteLength(marker)).toString('utf8').replace(/\uFFFD$/,'')+marker;
}
function boundedResult(profile:RunnerProfile,result:ExecutionResult,envelope:{runnerId:string;sessionId:string;ref:TaskRef},purpose?:'assess'|'decompose'){
  const assessed=purpose==='assess'&&!!result.assessmentEvaluation;
  if(result.assessmentEvaluation&&!assessed)throw Error('TypeSafe output requires an assessment attempt');
  if(profile==='codex-code'||profile==='dsh-text'){
    if(!result.nativeSession&&!assessed)throw Error('Native execution identity is required');
  }else if(result.code||result.codeArtifact)throw Error('Code results require a native Agent');
  if(purpose&&(result.code||result.codeArtifact))throw Error('Coordination cannot return code');
  const candidate=remoteResultSchema.parse({summary:clipText(result.summary,purpose==='decompose'?16000:8000),artifacts:result.artifacts.slice(0,3).map(a=>({name:a.name,content:clipText(a.content,12000)})),checksPassed:false,
    ...(result.assessmentEvaluation?{assessmentEvaluation:result.assessmentEvaluation}:{}),
    ...(result.nativeSession?{nativeSession:result.nativeSession}:{}),...(result.code?{code:result.code}:{}),...(result.codeArtifact?{codeArtifact:result.codeArtifact}:{})});
  const size=()=>Buffer.byteLength(JSON.stringify({...envelope,result:candidate}));
  const marker='\n[输出已截断：完整请求上限]',minimum=Buffer.byteLength(marker);
  for(let attempts=0;size()>FINISH_BODY_LIMIT&&attempts<64;attempts++){
    const fields:[number,()=>string,(value:string)=>void][]=[
      [Buffer.byteLength(candidate.summary),()=>candidate.summary,value=>{candidate.summary=value;}],
      ...candidate.artifacts.map(artifact=>[Buffer.byteLength(artifact.content),()=>artifact.content,(value:string)=>{artifact.content=value;}] as [number,()=>string,(value:string)=>void]),
    ];
    const selected=fields.filter(([bytes])=>bytes>minimum).sort((a,b)=>b[0]-a[0])[0];
    if(!selected)throw Error('Code result exceeds the complete finish request limit');
    selected[2](clipText(selected[1](),Math.max(minimum,Math.floor(selected[0]/2)),marker));
  }
  if(size()>FINISH_BODY_LIMIT)throw Error('Code result exceeds the complete finish request limit');
  return remoteResultSchema.parse(candidate);
}

/** Local native Agent worker with durable journal and server-controlled leases. */
export class TaskWorker {
  private base:string;
  private active?:Active;
  private stopped=false;
  private stepping=false;
  private profile:RunnerProfile;
  private codeBindings:CodeBinding[];
  private providers:WorkerProvider[];
  private nextProvider=0;
  private preparations=new Map<WorkerProvider,Preparation>();
  private sessionId?:string;
  constructor(private options:{server:string;identity:DeviceIdentity;journal:TaskJournal;executor:Executor;profile?:RunnerProfile;accepting?:()=>boolean;credentials?:WorkerProvider['credentials'];codeBindings?:CodeBinding[];providers?:WorkerProvider[];prepare?:WorkerProvider['prepare'];onSession?:(sessionId:string)=>void;localConfig?:{port:number;token:string}}){
    this.base=localDeviceServer(options.server);this.profile=runnerProfileSchema.parse(options.profile??'demo');
    this.codeBindings=z.array(codeBindingSchema).max(10).parse(options.codeBindings??[]);
    if(this.profile==='demo'&&this.codeBindings.length)throw Error('Code bindings require a native Agent');
    this.providers=options.providers??[{profile:this.profile,executor:options.executor,accepting:options.accepting,credentials:options.credentials,codeBindings:this.codeBindings,prepare:options.prepare}];
    if(!this.providers.length||this.providers.length>2||new Set(this.providers.map(p=>p.profile)).size!==this.providers.length)throw Error('Invalid provider selection');
    for(const provider of this.providers){
      runnerProfileSchema.parse(provider.profile);
      const bindings=z.array(codeBindingSchema).max(10).parse(provider.codeBindings??[]);
      if(provider.profile==='demo'&&bindings.length)throw Error('Code bindings require a native Agent');
      if(options.providers&&provider.profile==='demo')throw Error('Multiple provider mode requires native profiles');
    }
  }
  private call(sessionId:string,method:string,data:Record<string,unknown>={},signal=AbortSignal.timeout(5000)){
    return sendDeviceRequest(this.base,'/api/runner/tasks/'+method,{runnerId:this.options.identity.runnerId,sessionId,...data},this.options.identity.credential,signal,131072);
  }
  private blocked(){return new DeviceWorkBlocked('Unfinished task journal requires local process inspection; execution was not repeated');}
  private collect(active:Active,event:Omit<ConversationEntry,'at'>){
    const progress=active.progress;
    if(!progress||progress.disabled||active.terminal||active.broken||active.controller.signal.aborted)return;
    const parsed=conversationEntrySchema.safeParse({...event,text:typeof event.text==='string'?redactText(event.text).slice(0,4000):event.text,at:Date.now()});
    if(!parsed.success)return;
    const previous=progress.snapshot,entry=parsed.data,existing=previous.entries.find(item=>item.id===entry.id);
    if(existing?.kind===entry.kind&&existing.text===entry.text&&existing.state===entry.state)return;
    const entries=[...previous.entries.filter(item=>item.id!==entry.id),entry];
    const snapshot:ConversationSnapshot={revision:previous.revision+1,entries,truncated:previous.truncated||event.text.length>4000};
    while(entries.length>80||Buffer.byteLength(JSON.stringify(snapshot))>CONVERSATION_MAX_BYTES){entries.shift();snapshot.truncated=true;}
    progress.snapshot=snapshot;
  }
  private publishProgress(session:string,active:Active):Promise<void>{
    const progress=active.progress;
    if(!progress||progress.disabled||progress.sentRevision>=progress.snapshot.revision)return Promise.resolve();
    if(progress.upload)return progress.upload;
    const snapshot=progress.snapshot;
    progress.upload=(async()=>{
      try{
        z.object({ok:z.literal(true)}).strict().parse(await this.call(session,'progress',{ref:active.ref,snapshot},AbortSignal.timeout(1000)));
        progress.sentRevision=snapshot.revision;
      }catch(error){
        if(error instanceof DeviceResponseError&&error.status===404)progress.disabled=true;
      }finally{progress.upload=undefined;}
    })();
    return progress.upload;
  }
  private async flushProgress(session:string,active:Active){
    await active.progress?.upload;
    await this.publishProgress(session,active);
  }
  private async acknowledgeMessage(session:string,active:Active,signal:AbortSignal){
    const messages=active.messages,receipt=messages?.receipt;
    if(!messages||!receipt||messages.disabled)return;
    try{
      z.object({ok:z.literal(true)}).strict().parse(await this.call(session,'message-ack',{ref:active.ref,...receipt},signal));
      if(messages.receipt===receipt)messages.receipt=undefined;
    }catch(error){if(error instanceof DeviceResponseError&&[403,404,409].includes(error.status))messages.disabled=true;}
  }
  private deliverMessage(messages:Messages,handler:ExecutionMessageHandler,message:{id:string;text:string}){
    const previous=messages.sent.get(message.id);if(previous)return previous;
    if(messages.sent.size>=128)return Promise.resolve('rejected' as const);
    const receipt=new Promise<ExecutionMessageOutcome>(resolve=>{
      let settled=false;
      const done=(value:ExecutionMessageOutcome)=>{if(settled)return;settled=true;clearTimeout(timer);messages.controller.signal.removeEventListener('abort',aborted);resolve(value);};
      const aborted=()=>done('unknown'),timer=setTimeout(aborted,5000);
      messages.controller.signal.addEventListener('abort',aborted,{once:true});
      if(messages.controller.signal.aborted){aborted();return;}
      void Promise.resolve().then(()=>handler(message)).then(value=>done(['delivered','rejected','unknown'].includes(value)?value:'unknown'),()=>done('unknown'));
    });
    messages.sent.set(message.id,receipt);return receipt;
  }
  private receiveMessages(session:string,active:Active):Promise<void>{
    const messages=active.messages;
    if(!messages||messages.disabled||messages.closing||(!messages.handler&&!messages.receipt))return Promise.resolve();
    if(messages.inflight)return messages.inflight;
    messages.inflight=(async()=>{
      try{
        const signal=()=>AbortSignal.any([messages.controller.signal,AbortSignal.timeout(1000)]);
        if(messages.receipt){await this.acknowledgeMessage(session,active,signal());return;}
        const handler=messages.handler!;
        const result=runnerTaskMessageResponseSchema.parse(await this.call(session,'messages',{ref:active.ref},signal()));
        if(result.attemptId!==active.ref.attemptId){messages.disabled=true;return;}
        if(!result.message)return;
        const current=()=>this.active===active&&!active.terminal&&!active.broken&&!active.controller.signal.aborted&&!messages.closing&&messages.handler===handler;
        const outcome=current()?await this.deliverMessage(messages,message=>current()?handler(message):Promise.resolve('rejected'),result.message):'rejected';
        messages.receipt={messageId:result.message.id,outcome};
        if(!messages.closing)await this.acknowledgeMessage(session,active,signal());
      }catch(error){
        if(error instanceof z.ZodError||(error instanceof DeviceResponseError&&[403,404,409].includes(error.status)))messages.disabled=true;
      }finally{messages.inflight=undefined;}
    })();
    return messages.inflight;
  }
  private async closeMessages(session:string|undefined,active:Active){
    const messages=active.messages;if(!messages)return;
    messages.closing=true;messages.handler=undefined;messages.controller.abort();
    await messages.inflight;
    if(session)await this.acknowledgeMessage(session,active,AbortSignal.timeout(1000));
  }
  private async upload(session:string,ref:TaskRef,terminal:TaskTerminal){
    try{
      const response=terminal.kind==='result'?await this.call(session,'finish',{ref,result:terminal.result}):await this.call(session,'stopped',{ref,...(terminal.reason?{reason:terminal.reason}:{})});
      z.object({ok:z.literal(true)}).strict().parse(response);
    }catch(e){
      // Old servers reject the optional diagnostic at validation. Only that 400
      // can downgrade; authorization and transport failures retain the receipt.
      const legacyStop=terminal.kind==='stopped'&&terminal.reason&&e instanceof DeviceResponseError&&e.status===400;
      // A finished local process can supply stop evidence, but never override a stale result.
      const staleResult=terminal.kind==='result'&&e instanceof DeviceResponseError&&e.status===409;
      if(!legacyStop&&!staleResult)throw e;
      z.object({ok:z.literal(true)}).strict().parse(await this.call(session,'stopped',{ref}));
    }
    await this.options.journal.acknowledge(ref);
  }
  async step(sessionId:string){
    if(this.stopped||this.stepping)return;
    this.stepping=true;
    try{
      this.options.onSession?.(sessionId);
      this.sessionId=sessionId;
      if(!this.active){
        const pending=await this.options.journal.pending();
        if(pending.some(p=>!p.terminal))throw this.blocked();
        for(const p of pending)await this.upload(sessionId,p.ref,p.terminal!);
      }
      if(this.active){
        const active=this.active;
        if(active.broken)throw this.blocked();
        if(active.terminal){await this.closeMessages(sessionId,active);await this.flushProgress(sessionId,active);await this.upload(sessionId,active.ref,active.terminal);this.active=undefined;return;}
        const permit=z.object({action:z.enum(['continue','stop'])}).strict().parse(await this.call(sessionId,'renew',{ref:active.ref}));
        if(permit.action==='stop')active.controller.abort();
        else{clearTimeout(active.timer);active.timer=setTimeout(()=>active.controller.abort(),10000);}
        if(permit.action==='continue')void this.publishProgress(sessionId,active);
        if(permit.action==='continue')void this.receiveMessages(sessionId,active);
        if(this.options.providers&&permit.action==='continue'){
          // Availability has a shorter, isolated budget after the lease is
          // renewed. A failing provider announcement cannot starve execution,
          // while healthy providers remain visible during long native turns.
          try{
            const ready=this.providers.filter(provider=>!provider.accepting||provider.accepting());
            z.null().parse(await this.call(sessionId,'poll',{profile:this.providers[0].profile,readyProfiles:ready.map(p=>p.profile),credentials:ready.flatMap(p=>p.credentials?.()??[]),announceOnly:true,...(this.options.localConfig?{localConfig:this.options.localConfig}:{})},AbortSignal.timeout(1000)));
          }catch(error){
            if(error instanceof DeviceResponseError&&[400,401,403,404].includes(error.status))throw error;
          }
        }
        return;
      }
      const ready=this.providers.filter(provider=>!provider.accepting||provider.accepting());
      if(this.options.providers){
        // Availability must never delay an active attempt's renewal or receipt.
        try{
          z.null().parse(await this.call(sessionId,'poll',{profile:this.providers[0].profile,readyProfiles:ready.map(p=>p.profile),credentials:ready.flatMap(p=>p.credentials?.()??[]),announceOnly:true,...(this.options.localConfig?{localConfig:this.options.localConfig}:{})}));
        }catch(error){
          // An idle device can remain connected before the server enables the
          // task channel. Never apply this exception to renewal or receipts above,
          // or to authentication failures (401/403).
          if(error instanceof DeviceResponseError&&[404,503].includes(error.status))return;
          throw error;
        }
      }
      // Reconcile prior results even after local account admission closes. Never
      // request a fresh offer when quota/credential/consent checks have failed.
      let offer:TaskRef|null=null,selected:WorkerProvider|undefined;
      const firstProvider=this.nextProvider;
      for(let offset=0;offset<this.providers.length;offset++){
        const index=(firstProvider+offset)%this.providers.length,provider=this.providers[index];
        if(!ready.includes(provider))continue;
        if(provider.prepare){
          let preparation=this.preparations.get(provider);
          if(preparation&&preparation.sessionId!==sessionId){
            preparation.controller.abort();await preparation.promise;
            this.preparations.delete(provider);preparation=undefined;
          }
          if(!preparation){
            const controller=new AbortController();
            preparation={sessionId,controller,promise:Promise.resolve(),ready:false,failed:false};
            const current=preparation;
            current.promise=Promise.resolve().then(()=>provider.prepare!(sessionId,AbortSignal.any([controller.signal,AbortSignal.timeout(300000)])))
              .then(()=>{current.ready=true;},error=>{current.failed=true;current.error=error;});
            this.preparations.set(provider,current);
          }
          if(preparation.failed){this.preparations.delete(provider);throw preparation.error;}
          // Preparation may transfer a large base; return to the connection
          // loop so heartbeats and other profiles remain available meanwhile.
          if(!preparation.ready)continue;
        }
        // A response can disappear after the server reserves work. Retry this
        // provider first, so another profile cannot strand its reservation.
        this.nextProvider=index;
        try{offer=taskRefSchema.nullable().parse(await this.call(sessionId,'poll',{profile:provider.profile,
          ...(provider.profile!=='demo'?{codeBindings:provider.codeBindings??[]} : {}),
          ...(this.options.providers?{readyProfiles:ready.map(p=>p.profile)}:{}),credentials:ready.flatMap(p=>p.credentials?.()??[]),
          ...(this.options.localConfig?{localConfig:this.options.localConfig}:{})}));}
        catch(error){if(this.options.providers&&error instanceof DeviceResponseError&&error.status===503)continue;throw error;}
        if(offer){selected=provider;this.nextProvider=(index+1)%this.providers.length;break;}
      }
      if(!offer)return;
      this.profile=selected!.profile;this.codeBindings=selected!.codeBindings??[];
      if(!await this.options.journal.claim(offer))throw this.blocked();
      let input:z.infer<typeof remoteInputSchema>;
      try{
        input=remoteInputSchema.parse(await this.call(sessionId,'start',{ref:offer,profile:this.profile}));
        if(this.profile==='demo'&&input.code)throw Error('Task code input does not match the selected Runner profile');
      }
      catch(e){
        // This process has not invoked the executor. Persist that fact before reconciliation.
        await this.options.journal.finish(offer,{kind:'stopped'});
        await this.upload(sessionId,offer,{kind:'stopped'});
        if(e instanceof DeviceResponseError&&e.status===409)return;
        throw e;
      }
      if(input.attemptId!==offer.attemptId||input.taskId!==offer.taskId||input.fence!==offer.fence)throw this.blocked();
      const controller=new AbortController();
      const active:Active={ref:offer,controller,timer:setTimeout(()=>controller.abort(),10000),promise:Promise.resolve()};
      if(!input.purpose)active.progress={snapshot:{revision:1,entries:[],truncated:false},sentRevision:0};
      if(!input.purpose)active.messages={controller:new AbortController(),sent:new Map()};
      this.active=active;
      void this.publishProgress(sessionId,active);
      active.promise=(async()=>{
        let terminal:TaskTerminal;
        try{
          const result=await selected!.executor.run({...input,cwd:'',...(active.progress?{onProgress:(event:Omit<ConversationEntry,'at'>)=>this.collect(active,event)}:{}),
            ...(active.messages?{onMessageReady:(handler:ExecutionMessageHandler|null)=>{
              if(this.active!==active||active.terminal||active.broken||active.controller.signal.aborted)return;
              active.messages!.handler=handler??undefined;
              if(handler)void this.receiveMessages(this.sessionId??sessionId,active);
            }}:{})},controller.signal);
          if((this.profile==='dsh-text'||this.profile==='codex-code')&&!result.nativeSession&&!(input.purpose==='assess'&&result.assessmentEvaluation))throw Error('Native execution identity is required');
          terminal=controller.signal.aborted?{kind:'stopped'}:{kind:'result',result:boundedResult(this.profile,result,{runnerId:this.options.identity.runnerId,sessionId,ref:offer},input.purpose)};
        }catch(e){
          if(e instanceof ExecutorStopUnconfirmed){active.broken=true;return;}
          terminal=controller.signal.aborted?{kind:'stopped'}:{kind:'stopped',reason:e instanceof ExecutorTimeout?'timeout':'execution_failed'};
        }
        finally{clearTimeout(active.timer);}
        try{await this.options.journal.finish(offer,terminal);active.terminal=terminal;}
        catch{active.broken=true;}
      })();
    }catch(e){
      if(e instanceof DeviceResponseError||e instanceof DeviceWorkBlocked)throw e;
      // Transport failures retry in the connection loop; journal claims prevent any relaunch.
      if(!this.active){const pending=await this.options.journal.pending();if(pending.some(p=>!p.terminal))throw this.blocked();}
      throw e;
    }finally{this.stepping=false;}
  }
  async stop(sessionId?:string){
    this.stopped=true;
    for(const preparation of this.preparations.values())preparation.controller.abort();
    await Promise.allSettled([...this.preparations.values()].map(preparation=>preparation.promise));
    const active=this.active;
    if(!active)return;
    active.controller.abort();await active.promise;clearTimeout(active.timer);
    await this.closeMessages(sessionId,active);
    if(active.broken)throw this.blocked();
    if(sessionId&&active.terminal){try{await this.flushProgress(sessionId,active);await this.upload(sessionId,active.ref,active.terminal);}catch{/* Durable terminal record remains for authenticated replay. */}}
  }
}
