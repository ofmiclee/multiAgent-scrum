import {mkdir, lstat, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {join, resolve, isAbsolute} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Executor, ExecutionInput} from '../../packages/domain/contracts.ts';
import {DomainError} from '../../packages/domain/workflow.ts';
import {probeDshText} from '../../packages/executors/dsh-text-probe.ts';
import {DshTextExecutor} from '../../packages/executors/dsh-text-executor.ts';
import {describeDshProbeFailure} from '../../packages/executors/dsh-errors.ts';
import {ExecutorStopUnconfirmed} from '../../packages/domain/execution-errors.ts';

export type DshConnectionView = {
  status: 'disconnected' | 'connecting' | 'connected' | 'draining';
  localDetected: boolean | null;
  verified: boolean;
  code?: string;
};
export type DshConnectionOptions = {runtime: string; credentials: string};
type Backend = {probe: () => Promise<void>; run: Executor['run']};
const recordSchema = z.object({owner:z.string(), binding:z.string(), stamp:z.string(), draining:z.boolean()}).strict();
type Saved = z.infer<typeof recordSchema>;

/** Local consent only. No key resolution, account login/logout or shared identity. */
export class DshConnection implements Executor {
  readonly root: string;
  private record: Saved | null = null;
  private status: DshConnectionView['status'] = 'disconnected';
  private detected: boolean | null = null;
  private verified = false;
  private code?: string;
  private busy = false;
  private closing = false;
  private idleWaiters: Array<()=>void> = [];
  private probeBlocked=false;
  private backend: Backend;
  private readonly binding: string;
  constructor(root: string, readonly owner: string, private options: DshConnectionOptions, backend?: Backend) {
    this.root = resolve(root);
    if (![options.runtime, options.credentials].every(p => isAbsolute(p) && !/[\0\r\n]/.test(p)))
      throw Error('DSH connection configuration is invalid');
    this.binding = createHash('sha256').update(JSON.stringify(options)).digest('hex');
    const profile = {runtime:options.runtime, account:{kind:'local' as const, path:options.credentials}, maxTokens:2048, timeoutMs:120_000};
    this.backend = backend ?? {
      probe: async () => { await probeDshText({...profile, maxTokens:128, timeoutMs:30_000, modelCall:false}); },
      run: (input,signal) => {
        const expected=this.record?.stamp;
        // Pinned native credentials-local has loaded its snapshot by initialize;
        // watch:false and disabled writes keep that snapshot fixed until exit.
        return new DshTextExecutor(profile,async()=>{
          if(!expected || await this.stamp()!==expected) {
            this.code='CREDENTIAL_CHANGED';throw Error('DSH credential consent changed');
          }
        }).run(input,signal);
      },
    };
  }
  private async stamp() {
    const s = await lstat(this.options.credentials);
    if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077)
      throw Error('DSH local credential store is not a private regular file');
    // Native API has no stable account ID. Metadata detects ordinary file changes,
    // not a malicious same-user writer. Never read or hash credential contents.
    return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
  }
  private async save(value: Saved | null | boolean, name='connection.json', beforeCommit?:()=>void) {
    const file=join(this.root,name), temporary=file+'.'+randomUUID();
    try {
      await writeFile(temporary,JSON.stringify(value),{mode:0o600,flag:'wx',flush:true});
      // No await between the cancellation check and atomic publication. Once
      // rename is submitted, report its outcome, not a later cancellation.
      beforeCommit?.();
      await rename(temporary,file);
    } catch(error) {
      await unlink(temporary).catch(()=>{}); // An unpublished temp never grants consent.
      throw error;
    }
  }
  async initialize() {
    await mkdir(this.root,{recursive:true,mode:0o700});
    const dir=await lstat(this.root);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.mode & 0o077) throw Error('Unsafe DSH connection directory');
    try {
      const marker=join(this.root,'probe-quarantine.json'),s=await lstat(marker);
      if(!s.isFile() || s.isSymbolicLink() || s.mode & 0o077 || s.size>16)throw Error('Unsafe DSH probe marker');
      if(JSON.parse(await readFile(marker,'utf8'))!==true)throw Error('Invalid DSH probe marker');
      this.probeBlocked=true;this.status='draining';this.code='PROCESS_STOP_UNCONFIRMED';
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const file=join(this.root,'connection.json');
    let stat;
    try {stat=await lstat(file);} catch(e) {if ((e as NodeJS.ErrnoException).code==='ENOENT') return; throw e;}
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size>4096) throw Error('Unsafe DSH connection metadata');
    const raw:unknown=JSON.parse(await readFile(file,'utf8'));
    if (raw===null) return;
    const record=recordSchema.parse(raw);
    if (record.owner!==this.owner || record.binding!==this.binding) throw Error('DSH connection owner or runtime mismatch');
    this.record=record;
    this.status=record.draining||this.probeBlocked?'draining':'connected';
    try {if (await this.stamp()!==record.stamp) await this.block('CREDENTIAL_CHANGED');}
    catch {await this.block('CREDENTIAL_STORE');}
  }
  view(): DshConnectionView {return {status:this.status,localDetected:this.detected,verified:this.verified,...(this.code?{code:this.code}:{})};}
  available(owner:string) {return owner===this.owner && !!this.record && ['connected','draining'].includes(this.status);}
  accepting(owner:string) {return this.available(owner) && this.status==='connected' && !this.closing;}
  private idle() {
    if (this.closing || this.busy || this.status!=='disconnected') throw new DomainError('account_busy','请先断开当前 DSH 连接',409);
  }
  private settled() {this.busy=false;for(const done of this.idleWaiters.splice(0)) done();}
  private async probe() {
    // Record intent BEFORE launching. A crash or full disk after an uncertain
    // stop must not erase the only durable evidence of a possibly live probe.
    await this.save(true,'probe-quarantine.json');
    let stopped=true;
    try {await this.backend.probe();}
    catch(error) {
      if(error instanceof ExecutorStopUnconfirmed) {
        stopped=false;
        this.probeBlocked=true;this.status='draining';this.code='PROCESS_STOP_UNCONFIRMED';
      }
      throw error;
    } finally {
      if(stopped) {
        try {await unlink(join(this.root,'probe-quarantine.json'));}
        catch {this.probeBlocked=true;this.status='draining';this.code='CONNECTION_STORAGE_FAILED';throw Error('DSH probe recovery record could not be cleared');}
      }
    }
  }
  async detect() {
    this.idle(); this.busy=true;
    try {await this.stamp(); await this.probe(); this.detected=true; this.code=undefined;}
    catch(error) {this.detected=false;if(!this.probeBlocked)this.code=describeDshProbeFailure(error).code;}
    finally {this.settled();}
    return this.view();
  }
  async connectLocal() {
    this.idle(); this.busy=true;this.status='connecting';
    try {
      const stamp=await this.stamp(); await this.probe();
      if (await this.stamp()!==stamp || this.closing) throw Error('DSH credentials changed during connection');
      const record={owner:this.owner,binding:this.binding,stamp,draining:false};
      await this.save(record,'connection.json',()=>{if(this.closing)throw Error('DSH connection cancelled before commit');});
      this.record=record;this.status='connected';this.detected=true;this.verified=false;this.code=undefined;
    } catch(error) {if(!this.probeBlocked){this.status='disconnected';this.code=describeDshProbeFailure(error).code;}
      throw new DomainError('dsh_connection_failed','无法连接 DSH，请先在本机 DSH 配置账号，再重新检测',409);
    } finally {this.settled();}
    return this.view();
  }
  private async block(code:string) {
    this.status='draining';this.code=code;this.verified=false;
    if (this.record) {this.record.draining=true;await this.save(this.record);}
  }
  async disconnect(drain:()=>Promise<void>) {
    if(this.probeBlocked)throw new DomainError('dsh_probe_quarantined','检测进程停止未确认，需先由本机操作者核实并恢复',409);
    if(this.busy) throw new DomainError('account_busy','DSH 连接操作处理中',409);
    if(!this.record) return this.view();
    this.busy=true;
    try {await this.block(this.code??'DRAINING');await drain();await this.save(null);this.record=null;this.status='disconnected';this.verified=false;this.code=undefined;}
    finally {this.settled();}
    return this.view();
  }
  async run(input:ExecutionInput, signal:AbortSignal) {
    if(!this.record || !['connected','draining'].includes(this.status)) throw Error('DSH account is not connected');
    signal.throwIfAborted();
    try {
      if(await this.stamp()!==this.record.stamp) {await this.block('CREDENTIAL_CHANGED');throw Error('DSH credential store changed; reconnect required');}
      const result=await this.backend.run(input,signal);
      if(this.status==='connected') this.verified=true;
      return {...result,checksPassed:false};
    } catch(error) {
      if(!signal.aborted && this.status!=='draining') {
        try {await this.block(this.code??describeDshProbeFailure(error).code);}
        catch {this.status='draining';this.code='CONNECTION_STORAGE_FAILED';}
      }
      if(error instanceof ExecutorStopUnconfirmed) throw error;
      throw new Error('DSH execution failed ('+(this.code??describeDshProbeFailure(error).code)+')');
    }
  }
  async close() {this.closing=true;if(this.busy) await new Promise<void>(r=>this.idleWaiters.push(r));}
}
