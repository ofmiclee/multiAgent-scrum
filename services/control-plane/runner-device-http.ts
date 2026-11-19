import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {DomainError} from '../../packages/domain/workflow.ts';
import {RunnerDevices,pairSchema} from './runner-devices.ts';
import type {RunnerTasks} from './runner-tasks.ts';
import {taskRefSchema,remoteResultSchema,runnerProfileSchema} from '../../packages/domain/runner-protocol.ts';

async function readBody(req:IncomingMessage,limit=8192) {
  if(req.headers['content-type']?.split(';')[0]!=='application/json') throw new DomainError('invalid','需要 JSON 请求',415);
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req) {
    size+=chunk.length;
    if(size>limit) throw new DomainError('too_large','设备请求过大',413);
    chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new DomainError('invalid','JSON 格式无效',400);}
}

/** Native protocol has no cookie auth, no CORS and no browser Origin exceptions. */
export async function runnerDeviceHttp(req:IncomingMessage,res:ServerResponse,path:string,devices:RunnerDevices,tasks?:RunnerTasks) {
  if(req.headers.origin || req.headers.cookie || req.headers['sec-fetch-mode'])
    throw new DomainError('forbidden','设备接口不接受浏览器会话',403);
  if(req.method!=='POST') throw new DomainError('not_found','设备接口不存在',404);
  if(path.startsWith('/api/runner/tasks/')) {
    if(!tasks)throw new DomainError('unavailable','独立任务通道未启用',503);
    const credential=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization??'')?.[1];
    if(!credential)throw new DomainError('unauthorized','需要设备凭据',401);
    const method=path.slice('/api/runner/tasks/'.length);
    if(!['poll','start','renew','finish','stopped'].includes(method))throw new DomainError('not_found','设备接口不存在',404);
    const base=z.object({runnerId:z.string().uuid(),sessionId:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
    const data=await readBody(req,131072);
    let value:unknown;
    if(method==='poll'){
      const {profile,...auth}=base.extend({profile:runnerProfileSchema.default('demo')}).strict().parse(data);
      value=await tasks.poll({...auth,credential},profile);
    }
    else {
      const parsed=base.extend({ref:taskRefSchema,...(method==='finish'?{result:remoteResultSchema}:{}),...(method==='start'?{profile:runnerProfileSchema.default('demo')}:{})}).strict().parse(data);
      const auth={runnerId:parsed.runnerId,sessionId:parsed.sessionId,credential};
      if(method==='finish')value=await tasks.finish(auth,parsed.ref,remoteResultSchema.parse(parsed.result));
      else if(method==='start')value=await tasks.start(auth,parsed.ref,runnerProfileSchema.parse(parsed.profile));
      else if(method==='renew')value=await tasks.renew(auth,parsed.ref);
      else value=await tasks.stopped(auth,parsed.ref);
    }
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));return;
  }
  if(!['/api/runner/pair','/api/runner/connect','/api/runner/heartbeat','/api/runner/disconnect'].includes(path))
    throw new DomainError('not_found','设备接口不存在',404);
  const credential=/^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization??'')?.[1];
  if(path!=='/api/runner/pair' && !credential) throw new DomainError('unauthorized','需要设备凭据',401);
  const data=await readBody(req);
  let value:unknown;
  if(path==='/api/runner/pair') value=await devices.requestPair(pairSchema.parse(data));
  else if(path==='/api/runner/connect') {
    const {runnerId}=z.object({runnerId:z.string().uuid()}).strict().parse(data);
    value=await devices.connect(runnerId,credential!);
  } else {
    const {runnerId,sessionId}=z.object({runnerId:z.string().uuid(),sessionId:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(data);
    value=path.endsWith('/heartbeat') ? await devices.heartbeat(runnerId,credential!,sessionId) : await devices.disconnect(runnerId,credential!,sessionId);
  }
  res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}
