import {z} from 'zod';
import {accountRequest} from './account-api';

const rendezvous=z.object({identityId:z.string(),runnerId:z.uuid(),available:z.boolean(),port:z.number().int().min(1).max(65535).nullable(),token:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
const challenge=z.object({runnerId:z.uuid(),proof:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const saved=z.object({ok:z.literal(true),credential:z.object({id:z.uuid(),label:z.string()}).strict()}).strict();
function bytes(hex:string){return new Uint8Array(hex.match(/../g)!.map(pair=>parseInt(pair,16)));}
function hex(data:ArrayBuffer){return [...new Uint8Array(data)].map(value=>value.toString(16).padStart(2,'0')).join('');}

export async function connectLocalRunner(identityId:string,runnerId:string){
  const local=await accountRequest('/runner-local-config/'+encodeURIComponent(runnerId),rendezvous,{expectedIdentity:identityId});
  if(local.identityId!==identityId||local.runnerId!==runnerId||!local.available||!local.port||!local.token)throw Error('请安装并打开最新版 Runner，然后重试。');
  const base=`http://127.0.0.1:${local.port}`;
  const nonce=hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const proof=challenge.parse(await (await fetch(`${base}/challenge?nonce=${nonce}`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'})).json());
  const hmac=await crypto.subtle.importKey('raw',bytes(local.token),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const expected=hex(await crypto.subtle.sign('HMAC',hmac,new TextEncoder().encode(nonce)));
  if(proof.runnerId!==runnerId||proof.proof!==expected)throw Error('本机 Runner 身份校验失败，请勿输入密钥。');
  return {base,token:local.token};
}

export async function saveLocalApiKey(identityId:string,runnerId:string,profile:'codex-code'|'dsh-text',label:string,apiKey:string){
  const {base,token}=await connectLocalRunner(identityId,runnerId);
  const response=await fetch(`${base}/api-key`,{method:'POST',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json','X-MAS-Config-Token':token},body:JSON.stringify({profile,label,apiKey})});
  if(!response.ok)throw Error('本机配置失败，请检查 Key、Runner 状态与账号配置。');
  return saved.parse(await response.json()).credential;
}
