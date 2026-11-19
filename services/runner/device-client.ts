import {request} from 'node:http';
import {request as secureRequest} from 'node:https';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import type {DeviceIdentity} from './device-identity.ts';

export function localDeviceServer(value:string) {
  if(/[\s\p{Cc}\\?#]/u.test(value))throw Error('Invalid Runner server');
  const url=new URL(value);
  if((value==='https://scrum.fruitbuddy.cn'||value==='https://scrum.fruitbuddy.cn/')&&process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0')return url.origin;
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname!=='/')
    throw Error('Runner requires the approved HTTPS server or an explicit local preview port');
  if(!/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(value))throw Error('Invalid Runner server');
  return url.origin;
}
export class DeviceResponseError extends Error {
  constructor(readonly status:number) {super(`Device request rejected (${status})`);}
}
export class DeviceWorkBlocked extends Error {}
/** Transport does not imply product identity or project authority. Launch and
 * saved configuration also require the explicit approved-origin policy above. */
function deviceRequestUrl(base:string,path:string) {
  try {
    if(/[\s\p{Cc}\\?#]/u.test(base) || !/^https?:\/\/[^/]+\/?$/.test(base))throw Error();
    const url=new URL(base);
    if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error();
    if(url.protocol==='http:'){
      if(!/^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(base)||!url.port)throw Error();
    }else if(url.protocol!=='https:'||!url.hostname||process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error();
    if(!/^\/api\/runner\/(pair|connect|heartbeat|disconnect|status|capabilities|launch\/attach|tasks\/(poll|start|renew|finish|stopped|progress|messages|message-ack)|project-setup\/(poll|renew|finish|directory-poll|directory-finish)|repositories\/(begin|chunk|commit|abort|info|read)|code-artifacts\/(begin|chunk|commit|read))$/.test(path))throw Error();
    return new URL(path,url.origin);
  }catch{throw Error('Device connection unavailable: invalid or insecure endpoint');}
}
export async function sendDeviceRequest(base:string,path:string,body:unknown,credential:string|undefined,signal:AbortSignal,limit=8192):Promise<unknown> {
  const endpoint=deviceRequestUrl(base,path);
  let payload:string;
  try{
    payload=JSON.stringify(body);
    const payloadLimit=/^\/api\/runner\/(repositories|code-artifacts)\/chunk$/.test(path)?384*1024:256000;
    const responseLimit=/^\/api\/runner\/(repositories|code-artifacts)\/read$/.test(path)?384*1024:262144;
    if(typeof payload!=='string'||Buffer.byteLength(payload)>payloadLimit||!Number.isInteger(limit)||limit<1||limit>responseLimit||
      (credential!==undefined&&(!credential||credential.length>512||/[\s\p{Cc}]/u.test(credential))))throw Error();
  }catch{throw Error('Invalid device request');}
  return new Promise((resolve,reject)=>{
    // Node's request API never follows redirects. Explicit TLS validation also
    // prevents accidental inheritance of insecure process-wide defaults.
    const transport=endpoint.protocol==='https:'?secureRequest:request;
    const req=transport(endpoint,{method:'POST',...(endpoint.protocol==='https:'?{rejectUnauthorized:true}:{}),signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),headers:{
      'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),
      ...(credential?{Authorization:`Bearer ${credential}`}:{})}},res=>{
      const chunks:Buffer[]=[];let size=0;
      res.on('error',()=>reject(Error('Device response interrupted')));
      res.on('data',chunk=>{
        size+=chunk.length;
        if(size>limit){res.destroy();reject(Error('Device response exceeds limit'));return;}
        chunks.push(chunk);
      });
      res.on('end',()=>{
        if(res.statusCode!==200){reject(new DeviceResponseError(res.statusCode??500));return;}
        try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}
        catch{reject(Error('Invalid device response'));}
      });
    });
    req.on('error',()=>reject(Error('Device connection unavailable')));
    req.end(payload);
  });
}
const send=sendDeviceRequest;

export type DeviceEvent = {type:'pairing';runnerId:string;code:string;expiresAt:number}
  | {type:'connected'|'disconnected'|'reconnecting'|'blocked';runnerId:string};

/** Connection-only milestone: no Executor, database, Agent login or task dispatch. */
export async function runDeviceClient(options:{server:string;identity:DeviceIdentity;name:string;signal:AbortSignal;event:(event:DeviceEvent)=>void;tasks?:{step:(sessionId:string)=>Promise<void>;stop:(sessionId?:string)=>Promise<void>};setup?:{step:(sessionId:string)=>Promise<void>;stop?:()=>Promise<void>}}) {
  const base=localDeviceServer(options.server);
  const {identity,signal,event}=options;
  const name=z.string().trim().min(1).max(80).parse(options.name);
  let sessionId:string|undefined;
  let pairingUntil=0,backoff=1000,heartbeatMs=4000;
  const announce=(type:'connected'|'disconnected'|'reconnecting'|'blocked')=>event({type,runnerId:identity.runnerId});
  try {
    while(!signal.aborted) {
      let wait=heartbeatMs;
      try {
        if(!sessionId) {
          const result=z.object({sessionId:z.string().regex(/^[a-f0-9]{64}$/),heartbeatMs:z.number().int().min(1000).max(10000)}).strict().parse(
            await send(base,'/api/runner/connect',{runnerId:identity.runnerId},identity.credential,signal));
          sessionId=result.sessionId;heartbeatMs=result.heartbeatMs;pairingUntil=0;
          announce('connected');
        } else {
          z.object({ok:z.literal(true),executionReady:z.literal(false)}).strict().parse(await send(base,'/api/runner/heartbeat',{runnerId:identity.runnerId,sessionId},identity.credential,signal));
        }
        await options.tasks?.step(sessionId);
        await options.setup?.step(sessionId);
        backoff=1000;wait=heartbeatMs;
      } catch(error) {
        if(signal.aborted)break;
        if(error instanceof DeviceWorkBlocked){announce('blocked');throw error;}
        let failure:unknown=error;
        if(error instanceof DeviceResponseError && error.status===428) {
          try {
            if(pairingUntil<=Date.now()) {
              const pairing=z.object({code:z.string().regex(/^[A-F0-9]{16}$/),expiresAt:z.number().finite()}).strict().parse(await send(base,'/api/runner/pair',{
                runnerId:identity.runnerId,credentialHash:createHash('sha256').update(identity.credential).digest('hex'),name,
              },identity.credential,signal));
              pairingUntil=pairing.expiresAt;event({type:'pairing',runnerId:identity.runnerId,...pairing});
            }
            failure=undefined;wait=1000;
          } catch(pairError) {failure=pairError;}
        }
        if(signal.aborted)break;
        if(failure instanceof DeviceResponseError && [400,401,403,404].includes(failure.status)) {
          announce('blocked');throw Error('Runner binding rejected; inspect device authorization in Web');
        } else if(failure) {
          // Keep an authenticated session during transient network failure: a lost
          // heartbeat response must not create a competing connection immediately.
          if(failure instanceof DeviceResponseError && failure.status===409)sessionId=undefined;
          announce('reconnecting');wait=backoff+Math.floor(Math.random()*250);backoff=Math.min(backoff*2,10000);
        }
      }
      await delay(wait,undefined,{signal}).catch(error=>{if(!signal.aborted)throw error;});
    }
  } finally {
    await options.setup?.stop?.();
    await options.tasks?.stop(sessionId);
    if(sessionId) {
      try {await send(base,'/api/runner/disconnect',{runnerId:identity.runnerId,sessionId},identity.credential,AbortSignal.timeout(2000));}
      catch { /* No stop assertion: the service's heartbeat deadline remains authoritative. */ }
    }
    announce('disconnected');
  }
}
