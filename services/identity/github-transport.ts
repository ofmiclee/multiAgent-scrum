import type {BetterAuthPlugin} from 'better-auth';
import {authorizationCodeRequest,getOAuth2Tokens} from 'better-auth/oauth2';
import {z} from 'zod';
import type {GithubDiagnostic} from './service.ts';
import type {GithubRelay} from './github-relay.ts';

const tokenUrl='https://github.com/login/oauth/access_token';
const userUrl='https://api.github.com/user';
const emailUrl='https://api.github.com/user/emails';
const tokens=z.object({access_token:z.string().min(1).max(8192),token_type:z.string().optional(),refresh_token:z.string().max(8192).optional(),expires_in:z.number().positive().optional(),refresh_token_expires_in:z.number().positive().optional(),scope:z.string().optional()});
const profile=z.object({id:z.union([z.number().int().positive(),z.string().regex(/^\d+$/)]),login:z.string(),name:z.string().nullable().optional(),email:z.string().nullable().optional(),avatar_url:z.string().nullable().optional()});
const emails=z.array(z.object({email:z.string(),primary:z.boolean(),verified:z.boolean()})).max(1000);
const networkCodes=['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ETIMEDOUT','ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN'];
const providerCodes=['bad_verification_code','incorrect_client_credentials','redirect_uri_mismatch','unsupported_grant_type','unverified_user_email','access_denied','temporarily_unavailable','server_error'];
function networkCode(error:unknown){
  const e=error as {code?:unknown;cause?:{code?:unknown}}|undefined;
  return networkCodes.find(code=>code===e?.code||code===e?.cause?.code)??'unknown';
}

/** Keep Better Auth's state/PKCE, account linking and session machinery. Only
 * replace its unbounded GitHub network calls; never patch process-wide fetch. */
export function githubTransport(options:{
  credentials:{clientId:string;clientSecret:string};
  relay?:GithubRelay;
  signal:()=>AbortSignal;
  diagnose:(event:GithubDiagnostic)=>void;
}):BetterAuthPlugin{
  async function request(url:string,init:RequestInit,operation:'exchange'|'profile'|'email'):Promise<unknown>{
    const callbackSignal=options.signal();
    for(let attempt=1;attempt<=2;attempt++){
      const started=Date.now();
      // Includes response-body consumption, and fits inside the HTTP callback's
      // 30-second bound. A POST is retried only if connection never established.
      const signal=AbortSignal.any([callbackSignal,AbortSignal.timeout(12_000)]);
      let status:number|undefined;
      try{
        signal.throwIfAborted();
        const headers=new Headers(init.headers);
        if(options.relay)headers.set('X-MAS-Relay-Key',options.relay.key);
        const target=options.relay?options.relay.origin+'/'+operation:url;
        const response=await fetch(target,{...init,headers,redirect:'error',signal});
        status=response.status;
        const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
        if(reader){try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;
          size+=part.value.byteLength;if(size>262144)throw Error('GitHub response too large');chunks.push(part.value);
        }}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}}
        const text=Buffer.concat(chunks).toString('utf8');
        let data:unknown;try{data=JSON.parse(text);}catch{throw Error('GitHub response invalid');}
        const rawCode=data&&typeof data==='object'&&'error' in data?data.error:undefined;
        if(!response.ok||rawCode){
          const code=providerCodes.find(code=>code===rawCode)??'unknown';
          options.diagnose({phase:operation==='exchange'?'exchange':'transport',operation,code,...(!response.ok?{status:response.status}:{}),elapsedMs:Date.now()-started,attempt});
          throw Object.assign(new Error('GitHub request rejected'),{code:'GITHUB_REJECTED'});
        }
        options.diagnose({phase:'transport',operation,status:response.status,elapsedMs:Date.now()-started,attempt});
        return data;
      }catch(error){
        const code=networkCode(error);
        if((error as {code?:unknown})?.code!=='GITHUB_REJECTED')options.diagnose({phase:operation==='exchange'?'exchange':'transport',operation,code:signal.aborted?'request_timeout':code,...(status!==undefined?{status}:{}),elapsedMs:Date.now()-started,attempt});
        // Never replay a possibly consumed authorization code (reset, HTTP
        // failure, headers/body timeout or abort). GETs are safe to repeat.
        const safe=operation==='exchange'?['UND_ERR_CONNECT_TIMEOUT','EAI_AGAIN','ENOTFOUND','ECONNREFUSED'].includes(code):networkCodes.includes(code);
        if(attempt===2||callbackSignal.aborted||signal.aborted||!safe)throw error;
      }
    }
    throw Error('GitHub request unavailable');
  }
  return {id:'mas-github-transport',init(context){
    return {context:{socialProviders:context.socialProviders.map(provider=>provider.id!=='github'?provider:{
      ...provider,
      async validateAuthorizationCode({code,codeVerifier,redirectURI}){
        const {body,headers}=await authorizationCodeRequest({code,codeVerifier,redirectURI,options:options.credentials});
        return getOAuth2Tokens(tokens.parse(await request(tokenUrl,{method:'POST',body,headers},'exchange')));
      },
      async getUserInfo(token){
        const headers={'User-Agent':'MultiAgent-Scrum',Authorization:`Bearer ${token.accessToken}`,Accept:'application/json'};
        // Sequential to prevent an outstanding sibling request after failure.
        const user=profile.parse(await request(userUrl,{headers},'profile'));
        const addresses=emails.parse(await request(emailUrl,{headers},'email'));
        const email=user.email||(addresses.find(e=>e.primary)??addresses[0])?.email;
        return {user:{name:user.name||user.login,email,emailVerified:addresses.find(e=>e.email===email)?.verified??false,image:user.avatar_url??undefined},data:user};
      },
    })}};
  }};
}
