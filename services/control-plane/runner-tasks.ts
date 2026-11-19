import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {taskRefSchema,remoteResultSchema,runnerProfileSchema,type RunnerProfile,type TaskRef,type RemoteResult} from '../../packages/domain/runner-protocol.ts';
import type {State,Task} from '../../packages/domain/contracts.ts';
import {schedule,start,heartbeat,report,fail,expire,DomainError} from '../../packages/domain/workflow.ts';
import {taskAdmission} from '../../packages/domain/task-admission.ts';
import {isProjectMember} from '../../packages/domain/access.ts';
import {normalizeResult} from '../runner/results.ts';
import type {Repository} from './repository.ts';
import type {RunnerDevices} from './runner-devices.ts';

export type DeviceAuth={runnerId:string;credential:string;sessionId:string};
const stale=()=>new DomainError('stale_execution','执行授权或尝试已失效',409);
const ref=(t:Task):TaskRef=>({taskId:t.id,attemptId:t.attempts.at(-1)!.id,fence:t.fence!});

/** Native task transport shares the existing authoritative workflow transaction. */
export class RunnerTasks {
  constructor(private repo:Repository,private devices:RunnerDevices,private clock=()=>Date.now(),private options:{allowDsh?:boolean}={}) {}
  private profile(value:RunnerProfile){
    runnerProfileSchema.parse(value);
    if(value==='codex-code')throw new DomainError('unavailable','Codex 代码执行仅支持正式账号通道',503);
    if(value==='dsh-text'&&!this.options.allowDsh)throw new DomainError('unavailable','独立 DSH 文本通道未启用',503);
    return value==='dsh-text'?{provider:'dsh' as const,mode:'remote-dsh-text' as const,name:'独立 Runner · DSH 文本执行'}:{provider:'demo' as const,mode:'remote-demo' as const,name:'独立 Runner · 模拟文本执行'};
  }
  async initialize() {
    await this.repo.pool.query(`CREATE TABLE IF NOT EXISTS mas_preview_runner_receipts (
      workspace_key text NOT NULL, attempt_id text NOT NULL, runner_id uuid NOT NULL,
      fence bigint NOT NULL, digest text NOT NULL, PRIMARY KEY(workspace_key,attempt_id)
    )`);
  }
  private async transact<T>(auth:DeviceAuth,fn:(s:State,c:PoolClient,owner:string)=>Promise<T>|T) {
    return this.devices.withSession(auth,async(c,owner)=>{
      const rows=await c.query('SELECT state FROM mas_preview_workspace WHERE workspace_key=$1 FOR UPDATE',[this.repo.key]);
      const before=rows.rows[0].state as State,s=structuredClone(before);
      expire(s,this.clock());
      const result=await fn(s,c,owner);
      if(!isDeepStrictEqual(before,s)) {
        s.revision++;
        await c.query('UPDATE mas_preview_workspace SET state=$2::jsonb,revision=$3,updated_at=now() WHERE workspace_key=$1',[this.repo.key,JSON.stringify(s),s.revision]);
      }
      return result;
    });
  }
  private matching(s:State,auth:DeviceAuth,owner:string,r:TaskRef) {
    taskRefSchema.parse(r);
    const t=s.tasks.find(t=>t.id===r.taskId),a=s.agents.find(a=>a.id===t?.agentId),attempt=t?.attempts.at(-1);
    if(!t||!a||!((a.executionMode==='remote-demo'&&a.provider==='demo')||(a.executionMode==='remote-dsh-text'&&a.provider==='dsh'))||a.deviceId!==auth.runnerId||a.ownerId!==owner||
      t.responsibleUserId!==owner||attempt?.id!==r.attemptId||attempt.deviceId!==auth.runnerId||attempt.fence!==r.fence||t.fence!==r.fence)throw stale();
    return {t,a};
  }
  private historical(s:State,auth:DeviceAuth,owner:string,r:TaskRef) {
    taskRefSchema.parse(r);
    const t=s.tasks.find(t=>t.id===r.taskId),attempt=t?.attempts.find(a=>a.id===r.attemptId);
    if(!t||!attempt||attempt.ownerId!==owner||attempt.deviceId!==auth.runnerId||attempt.fence!==r.fence)throw stale();
    return t;
  }
  private authorized(s:State,auth:DeviceAuth,owner:string,r:TaskRef) {
    const {t,a}=this.matching(s,auth,owner,r),p=s.projects.find(p=>p.id===t.projectId);
    if(!a.enabled||!a.projectIds.includes(t.projectId)||!isProjectMember(s,owner,p)||t.capability!=='writing'||
      (t.assessment?.requiredCapability??'writing')!=='writing'||t.attempts.at(-1)?.codeContext||
      !['assigned','running'].includes(t.status)||(t.leaseUntil??0)<=this.clock())throw stale();
    return t;
  }
  async poll(auth:DeviceAuth,profile:RunnerProfile='demo'):Promise<TaskRef|null> {
    const spec=this.profile(profile);
    return this.transact(auth,(s,_c,owner)=>{
      const id=`${spec.mode}-${auth.runnerId}`;
      let agent=s.agents.find(a=>a.id===id);
      if(!agent){agent={id,name:spec.name,deviceId:auth.runnerId,ownerId:owner,provider:spec.provider,executionMode:spec.mode,capabilities:['writing'],maxConcurrency:1,enabled:false,online:true,projectIds:[]};s.agents.push(agent);}
      if(agent.ownerId!==owner||agent.deviceId!==auth.runnerId)throw stale();
      agent.online=true;
      agent.remoteReadyUntil=this.clock()+10000;
      for(const other of s.agents.filter(a=>a.deviceId===auth.runnerId&&a.executionMode&&a.id!==id)){other.online=false;other.remoteReadyUntil=0;}
      const unsettled=s.tasks.find(t=>t.attempts.at(-1)?.deviceId===auth.runnerId&&(t.recoveryRequired||['assigned','running'].includes(t.status)));
      if(unsettled){if(unsettled.agentId!==id)throw stale();return ref(unsettled);}
      const blocked=new Set(s.agents.filter(a=>a.id!==id).map(a=>a.id));
      const candidate=[...s.tasks].sort((a,b)=>a.priority-b.priority||a.createdAt.localeCompare(b.createdAt)).find(t=>
        t.capability==='writing'&&taskAdmission(s,t,blocked)?.status.ready);
      if(!candidate)return null;
      const stopping=new Set(s.tasks.filter(t=>t.id!==candidate.id).map(t=>t.id));
      const [assigned]=schedule(s,this.clock(),stopping,new Set(),blocked,auth.runnerId);
      return assigned?ref(assigned):null;
    });
  }
  async start(auth:DeviceAuth,r:TaskRef,profile:RunnerProfile='demo') {
    const spec=this.profile(profile);
    return this.transact(auth,(s,_c,owner)=>{
      const t=this.authorized(s,auth,owner,r);
      if(s.agents.find(a=>a.id===t.agentId)?.executionMode!==spec.mode)throw stale();
      if(t.status==='assigned')start(s,t.id,r.fence,this.clock());
      // Deliberately no cwd, account data, arbitrary commands or repository bytes.
      const input={...r,title:t.title,description:t.description,acceptance:t.acceptance,feedback:t.feedback};
      if(Buffer.byteLength(JSON.stringify(input))>64000)throw new DomainError('input_limit','任务输入超过独立文本通道限制',413);
      return input;
    });
  }
  async renew(auth:DeviceAuth,r:TaskRef) {
    return this.transact(auth,(s,_c,owner)=>{
      const {a}=this.matching(s,auth,owner,r);a.remoteReadyUntil=this.clock()+10000;
      try {const t=this.authorized(s,auth,owner,r);heartbeat(s,t.id,r.fence,this.clock());return {action:'continue' as const};}
      catch {const {t}=this.matching(s,auth,owner,r);if(['assigned','running'].includes(t.status))fail(s,t.id,r.fence,'独立执行授权已撤销，等待停止确认',this.clock());return {action:'stop' as const};}
    });
  }
  async finish(auth:DeviceAuth,r:TaskRef,value:RemoteResult) {
    const result=remoteResultSchema.parse(value),hash=createHash('sha256').update(JSON.stringify(result)).digest('hex');
    if(result.code)throw new DomainError('unsupported_result','预览文本通道不接受代码成果',400);
    return this.transact(auth,async(s,c,owner)=>{
      this.historical(s,auth,owner,r);
      const receipt=await c.query('SELECT runner_id,fence,digest FROM mas_preview_runner_receipts WHERE workspace_key=$1 AND attempt_id=$2',[this.repo.key,r.attemptId]);
      if(receipt.rows[0]) {
        const old=receipt.rows[0];if(old.runner_id!==auth.runnerId||Number(old.fence)!==r.fence||old.digest!==hash)throw new DomainError('receipt_conflict','执行回执内容冲突',409);
        return {ok:true as const};
      }
      const t=this.authorized(s,auth,owner,r);
      if(t.status!=='running')throw stale();
      if(s.agents.find(a=>a.id===t.agentId)?.executionMode==='remote-dsh-text'&&!result.nativeSession)
        throw new DomainError('native_evidence_required','DSH 成果缺少原生执行会话标识',400);
      report(s,t.id,r.fence,normalizeResult(result),this.clock());
      await c.query('INSERT INTO mas_preview_runner_receipts VALUES ($1,$2,$3,$4,$5)',[this.repo.key,r.attemptId,auth.runnerId,r.fence,hash]);
      return {ok:true as const};
    });
  }
  async stopped(auth:DeviceAuth,r:TaskRef) {
    return this.transact(auth,async(s,c,owner)=>{
      const t=this.historical(s,auth,owner,r);
      if(t.attempts.at(-1)?.id===r.attemptId&&t.fence===r.fence){
        if(['assigned','running'].includes(t.status))fail(s,t.id,r.fence,'独立 Runner 已终止本次执行',this.clock());
        if(t.status==='failed')t.recoveryRequired=false;
      }
      await c.query('INSERT INTO mas_preview_runner_receipts VALUES ($1,$2,$3,$4,$5) ON CONFLICT(workspace_key,attempt_id) DO NOTHING',[this.repo.key,r.attemptId,auth.runnerId,r.fence,'stopped']);
      return {ok:true as const};
    });
  }
}
