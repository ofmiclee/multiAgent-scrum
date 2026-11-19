import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Repository} from './repository.ts';
import {DomainError} from '../../packages/domain/workflow.ts';

const digest = (value:string) => createHash('sha256').update(value).digest('hex');
const keySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const pairSchema = z.object({runnerId:z.string().uuid(), credentialHash:keySchema, name:z.string().trim().min(1).max(80)}).strict();
export type DeviceView = {runnerId:string; name:string; online:boolean; lastSeen:number|null; revoked:boolean; executionReady:false};
type DeviceRecord = {
  runnerId:string; name:string; credentialHash:string; ownerId:string|null;
  pairHash:string|null; pairUntil:number; revoked:boolean;
  sessionHash:string|null; sessionUntil:number; lastSeen:number|null;
};
const denied = () => new DomainError('device_unauthorized','设备认证失败或绑定已撤销',403);
function matches(secret:string, hash:string|null) {
  return !!hash && timingSafeEqual(Buffer.from(digest(secret),'hex'), Buffer.from(hash,'hex'));
}

/** Independent private preview registry. Never serialize records into shared workspace state. */
export class RunnerDevices {
  constructor(private repo:Repository, private clock = () => Date.now()) {}
  async initialize() {
    await this.repo.pool.query(`CREATE TABLE IF NOT EXISTS mas_preview_runner_devices (
      workspace_key text NOT NULL, runner_id uuid NOT NULL, record jsonb NOT NULL,
      PRIMARY KEY (workspace_key, runner_id)
    )`);
  }
  private async transaction<T>(fn:(client:PoolClient)=>Promise<T>) {
    const client=await this.repo.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[`mas-device-registry:${this.repo.key}`]);
      const value=await fn(client);
      await client.query('COMMIT');
      return value;
    } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally {client.release();}
  }
  private async get(client:PoolClient,id:string):Promise<DeviceRecord|undefined> {
    z.string().uuid().parse(id);
    const rows=await client.query('SELECT record FROM mas_preview_runner_devices WHERE workspace_key=$1 AND runner_id=$2',[this.repo.key,id]);
    return rows.rows[0]?.record;
  }
  private async save(client:PoolClient,r:DeviceRecord) {
    await client.query(`INSERT INTO mas_preview_runner_devices (workspace_key, runner_id, record)
      VALUES ($1,$2,$3::jsonb) ON CONFLICT (workspace_key, runner_id) DO UPDATE SET record=EXCLUDED.record`,[this.repo.key,r.runnerId,JSON.stringify(r)]);
  }
  async requestPair(value:z.infer<typeof pairSchema>) {
    const input=pairSchema.parse(value);
    return this.transaction(async c=>{
      const old=await this.get(c,input.runnerId);
      if(old && (old.ownerId || old.revoked || old.credentialHash!==input.credentialHash)) throw denied();
      if(!old) {
        const count=await c.query('SELECT count(*) FROM mas_preview_runner_devices WHERE workspace_key=$1',[this.repo.key]);
        if(Number(count.rows[0].count)>=1000) throw new DomainError('device_limit','设备预览记录已满',429);
      }
      const code=randomBytes(8).toString('hex').toUpperCase();
      const expiresAt=this.clock()+300000;
      await this.save(c, {...input,ownerId:null,pairHash:digest(code),pairUntil:expiresAt,revoked:false,sessionHash:null,sessionUntil:0,lastSeen:null});
      return {code,expiresAt};
    });
  }
  async bind(ownerId:string,code:string) {
    z.string().regex(/^[A-F0-9]{16}$/).parse(code);
    return this.transaction(async c=>{
      const workspace=await c.query('SELECT state FROM mas_preview_workspace WHERE workspace_key=$1',[this.repo.key]);
      if(!workspace.rows[0]?.state.users.some((u:{id:string})=>u.id===ownerId)) throw denied();
      const rows=await c.query("SELECT record FROM mas_preview_runner_devices WHERE workspace_key=$1 AND record->>'pairHash'=$2",[this.repo.key,digest(code)]);
      const r=rows.rows[0]?.record as DeviceRecord|undefined;
      if(!r || r.revoked || r.ownerId || r.pairUntil<=this.clock()) throw new DomainError('pair_invalid','配对码已过期、已使用或无效',409);
      r.ownerId=ownerId;r.pairHash=null;r.pairUntil=0;
      await this.save(c,r);
      return {runnerId:r.runnerId};
    });
  }
  private authenticated(r:DeviceRecord|undefined,credential:string):DeviceRecord {
    keySchema.parse(credential);
    if(!r) throw new DomainError('pair_required','设备尚未绑定',428);
    if(r.revoked || !matches(credential,r.credentialHash)) throw denied();
    if(!r.ownerId) throw new DomainError('pair_required','设备尚未绑定',428);
    return r;
  }
  async connect(runnerId:string,credential:string) {
    return this.transaction(async c=>{
      const r=this.authenticated(await this.get(c,runnerId),credential);
      const now=this.clock();
      if(r.sessionHash && r.sessionUntil>now) throw new DomainError('device_session_active','设备已有有效连接 session',409);
      const sessionId=randomBytes(32).toString('hex');
      r.sessionHash=digest(sessionId);r.lastSeen=now;r.sessionUntil=now+15000;
      await this.save(c,r);
      return {sessionId,heartbeatMs:4000};
    });
  }
  private async session(c:PoolClient,id:string,key:string,session:string) {
    keySchema.parse(session);
    const r=this.authenticated(await this.get(c,id),key);
    if(!matches(session,r.sessionHash) || r.sessionUntil<=this.clock()) throw new DomainError('device_session_stale','设备连接已失效，请重新连接',409);
    return r;
  }
  async heartbeat(id:string,key:string,session:string) {
    return this.transaction(async c=>{
      const r=await this.session(c,id,key,session);
      r.lastSeen=this.clock();r.sessionUntil=r.lastSeen+15000;
      await this.save(c,r);
      return {ok:true, executionReady:false as const};
    });
  }
  /** Server-only transaction boundary: device auth remains locked through task mutation. */
  async withSession<T>(auth:{runnerId:string;credential:string;sessionId:string},fn:(client:PoolClient,ownerId:string)=>Promise<T>) {
    return this.transaction(async c=>{
      const r=await this.session(c,auth.runnerId,auth.credential,auth.sessionId);
      return fn(c,r.ownerId!);
    });
  }
  async disconnect(id:string,key:string,session:string) {
    return this.transaction(async c=>{
      const r=await this.session(c,id,key,session);
      r.sessionHash=null;r.sessionUntil=0;
      await this.save(c,r);
      return {ok:true};
    });
  }
  async revoke(ownerId:string,runnerId:string) {
    return this.transaction(async c=>{
      const r=await this.get(c,runnerId);
      if(!r || r.ownerId!==ownerId) throw denied();
      r.revoked=true;r.sessionHash=null;r.sessionUntil=0;
      await this.save(c,r);
      return {ok:true};
    });
  }
  async list(ownerId:string):Promise<DeviceView[]> {
    const result=await this.repo.pool.query("SELECT record FROM mas_preview_runner_devices WHERE workspace_key=$1 AND record->>'ownerId'=$2 ORDER BY runner_id",[this.repo.key,ownerId]);
    const now=this.clock();
    return result.rows.map(({record:r}:{record:DeviceRecord})=>({
      runnerId:r.runnerId,name:r.name,online:!r.revoked && !!r.sessionHash && r.sessionUntil>now,
      lastSeen:r.lastSeen,revoked:r.revoked,executionReady:false,
    }));
  }
}
