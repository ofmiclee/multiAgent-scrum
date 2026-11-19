import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {z} from 'zod';
import {NativeSessionService,sessionSendSchema} from './native-sessions.ts';

const keyRequest=z.object({profile:z.enum(['codex-code','dsh-text']),label:z.string().trim().min(1).max(80),
  apiKey:z.string().trim().min(1).max(1024).regex(/^[\x21-\x7e]+$/)}).strict();
type Profile='codex-code'|'dsh-text';

/** Only the authenticated owner receives the short-lived rendezvous token.
 * A challenge proves the process at this port is that Runner before Web sends a key. */
export async function openLocalKeyBridge(options:{origin:string;runnerId:string;add:(profile:Profile,label:string,key:string)=>Promise<{id:string;label:string}>;codexCommand?:string;dshConfigured?:()=>Promise<boolean>}){
  const token=randomBytes(32).toString('hex');
  const nativeSessions=new NativeSessionService({codexCommand:options.codexCommand,dshConfigured:options.dshConfigured});
  let port=0,busy=false;
  const send=(response:ServerResponse,status:number,body:object)=>{
    response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    response.end(JSON.stringify(body));
  };
  const server=createServer(async(request:IncomingMessage,response:ServerResponse)=>{
    response.setHeader('Cache-Control','no-store');response.setHeader('X-Content-Type-Options','nosniff');
    if(request.headers.origin!==options.origin||request.headers.host!==`127.0.0.1:${port}`){send(response,403,{ok:false});return;}
    response.setHeader('Access-Control-Allow-Origin',options.origin);
    response.setHeader('Vary','Origin');
    response.setHeader('Access-Control-Allow-Private-Network','true');
    if(request.method==='OPTIONS'){
      response.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers','Content-Type, X-MAS-Config-Token');
      response.writeHead(204);response.end();return;
    }
    const target=new URL(request.url??'/',`http://127.0.0.1:${port}`);
    if(request.method==='GET'&&target.pathname==='/challenge'&&target.searchParams.size===1){
      const nonce=target.searchParams.get('nonce');
      if(!nonce||!/^[a-f0-9]{32}$/.test(nonce)){send(response,400,{ok:false});return;}
      send(response,200,{runnerId:options.runnerId,proof:createHmac('sha256',Buffer.from(token,'hex')).update(nonce).digest('hex')});return;
    }
    const supplied=request.headers['x-mas-config-token'];
    if(typeof supplied!=='string'||!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied,'hex'),Buffer.from(token,'hex'))){send(response,403,{ok:false});return;}
    if(target.search){send(response,404,{ok:false});return;}
    if(request.method==='GET'&&target.pathname==='/native-sessions'){
      try{send(response,200,{ok:true,...await nativeSessions.list()});}catch{send(response,503,{ok:false});}return;
    }
    const operation=/^\/native-sessions\/operations\/([a-f0-9-]{36})(\/cancel)?$/.exec(target.pathname);
    if(operation&&((request.method==='GET'&&!operation[2])||(request.method==='POST'&&!!operation[2]))){
      try{send(response,200,{ok:true,...(operation[2]?nativeSessions.cancel(operation[1]):nativeSessions.status(operation[1]))});}
      catch{send(response,404,{ok:false});}return;
    }
    const transcript=/^\/native-sessions\/transcript\/(codex|claude|codebuddy|dsh)\/([a-f0-9-]{36})(?:\/before\/([0-9]{1,5}))?$/.exec(target.pathname);
    if(transcript&&request.method==='GET'){
      try{send(response,200,{ok:true,...await nativeSessions.transcript(transcript[1] as 'codex'|'claude'|'codebuddy'|'dsh',transcript[2],transcript[3])});}
      catch{send(response,404,{ok:false});}return;
    }
    if(request.method==='POST'&&target.pathname==='/native-sessions/send'){
      try{
        let body='';for await(const chunk of request){body+=chunk.toString();if(Buffer.byteLength(body)>10_000)throw Error('Invalid input');}
        send(response,200,{ok:true,...await nativeSessions.send(sessionSendSchema.parse(JSON.parse(body)))});
      }catch{send(response,409,{ok:false,error:'会话不可用、正在运行，或本机操作未能启动。'});}return;
    }
    if(request.method!=='POST'||target.pathname!=='/api-key'||busy){send(response,busy?409:404,{ok:false});return;}
    busy=true;
    try{
      let body='';for await(const chunk of request){body+=chunk.toString();if(Buffer.byteLength(body)>2048)throw Error('Invalid input');}
      const input=keyRequest.parse(JSON.parse(body));
      const credential=await options.add(input.profile,input.label,input.apiKey);
      send(response,200,{ok:true,credential});
    }catch{send(response,400,{ok:false,error:'本机配置失败，请检查 API Key 和 Runner 配置。'});}
    finally{busy=false;}
  });
  try{
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    const address=server.address();if(!address||typeof address==='string')throw Error('Invalid local bridge address');port=address.port;
    return {port,token,close:async()=>{await nativeSessions.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
  }catch(error){server.close();throw error;}
}
