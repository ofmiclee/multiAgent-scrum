import type {IncomingMessage,ServerResponse} from 'node:http';
import type {IdentityService} from './service.ts';

const defaultBodyLimit=16_384,maximumBodyLimit=96*1024;
const passwordProcessingPaths=new Set(['/api/identity/sign-up/email','/api/identity/sign-in/email','/api/identity/reset-password']);
type IntakeTarget={method:string;pathname:string;search:string};

function boundedBody(req:IncomingMessage,maxBytes:number):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0;
    const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',failed);req.off('aborted',failed);};
    const data=(chunk:Buffer)=>{
      size+=chunk.length;
      if(size>maxBytes){cleanup();req.resume();reject(413);return;}
      chunks.push(chunk);
    };
    const end=()=>{cleanup();resolve(Buffer.concat(chunks));};
    const failed=()=>{cleanup();reject(400);};
    req.on('data',data);req.on('end',end);req.on('error',failed);req.on('aborted',failed);
  });
}
function rejected(res:ServerResponse,status:number) {
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',Connection:'close'});
  res.end(JSON.stringify({error:{code:status===503?'identity_unavailable':'identity_denied'}}));
}

/** No proxy/header-based identity and no general-purpose auth endpoint forwarding. */
export function createIdentityHttpHandler(identity:Pick<IdentityService,'handle'>,origin:string,
  options:{bodyLimit?:(target:IntakeTarget)=>number;nativeRunner?:boolean;bodyImages?:boolean;profileImages?:boolean}={}) {
  const configured=new URL(origin);
  if(configured.origin!==origin)throw Error('Identity HTTP requires an exact origin');
  return async(req:IncomingMessage,res:ServerResponse)=>{
    let processingTimer:ReturnType<typeof setTimeout>|undefined;
    try {
      req.setTimeout(5000,()=>req.destroy());
      if(req.headers.host!==configured.host){req.resume();rejected(res,403);return;}
      if(!req.url?.startsWith('/')||req.url.startsWith('//')||/[\\#\s]/.test(req.url)){
        req.resume();rejected(res,400);return;
      }
      if(options.nativeRunner&&['origin','cookie','sec-fetch-mode','sec-fetch-site','sec-fetch-dest'].some(h=>req.headers[h]!==undefined)){
        req.resume();rejected(res,403);return;
      }
      const target=new URL(req.url,origin),selected=options.bodyLimit?.({
        method:req.method??'',pathname:target.pathname,search:target.search,
      })??defaultBodyLimit;
      const imageUpload=options.bodyImages&&!options.nativeRunner&&req.method==='POST'&&!target.search&&/^\/api\/account\/projects\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/body-images$/.test(target.pathname);
      const profileUpload=options.profileImages&&!options.nativeRunner&&req.method==='POST'&&!target.search&&target.pathname==='/api/account/profile';
      const ceiling=imageUpload||profileUpload?14*1024*1024:options.nativeRunner&&req.method==='POST'&&!target.search&&/^\/api\/runner\/(repositories|code-artifacts)\/chunk$/.test(target.pathname)?384*1024:maximumBodyLimit;
      const maxBytes=Number.isInteger(selected)&&selected>=1&&selected<=ceiling?selected:defaultBodyLimit;
      const length=req.headers['content-length'];
      if(length && (!/^\d+$/.test(length)||Number(length)>maxBytes)){
        req.resume();rejected(res,413);return;
      }
      const headers=new Headers();
      // The native bridge never forwards browser identity, and the default
      // identity bridge never forwards a Runner bearer as a user credential.
      for(const name of options.nativeRunner?['authorization','content-type']:['cookie','origin','content-type','sec-fetch-site']) {
        const value=req.headers[name];
        if(typeof value==='string')headers.set(name,value);
      }
      // Versioned, read-only rendering metadata; never a source of identity or
      // authority. Keep old strict clients on the unchanged task-list shape.
      if(!options.nativeRunner&&req.method==='GET'&&/^\/api\/account\/projects\/[^/]+\/(?:tasks(?:\/before\/[^/]+)?|boards\/[^/]+\/tasks\/[^/]+)$/.test(target.pathname)
        &&req.headers['x-mas-task-presentation']==='1')headers.set('X-MAS-Task-Presentation','1');
      const body=req.method==='POST'?await boundedBody(req,maxBytes):undefined;
      if(req.method!=='POST')req.resume();
      // Only after complete password-request intake may expensive authentication
      // take longer. Never extend upload/native intake or arbitrary account routes.
      const authProcessing=!options.nativeRunner&&(
        (req.method==='POST'&&!target.search&&passwordProcessingPaths.has(target.pathname))||
        (req.method==='GET'&&target.pathname==='/api/identity/callback/github'));
      if(authProcessing){
        req.setTimeout(30_000);
        // A wall-clock response bound, not just a socket inactivity timeout.
        // The operation still settles normally for draining/idempotent semantics.
        processingTimer=setTimeout(()=>res.destroy(),30_000);
      }
      const request=new Request(new URL(req.url,origin),{
        method:req.method,headers,body:body?new Uint8Array(body):undefined,
      });
      const result=await identity.handle(request);
      if(res.destroyed)return;
      res.statusCode=result.status;
      result.headers.forEach((value,key)=>{if(key!=='set-cookie')res.setHeader(key,value);});
      const cookies=result.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);
      res.end(Buffer.from(await result.arrayBuffer()));
    }catch(e){
      if(!res.headersSent && !res.destroyed)rejected(res,e===413?413:e===400?400:503);
      else if(!res.destroyed)res.end();
    }finally{if(processingTimer)clearTimeout(processingTimer);}
  };
}
