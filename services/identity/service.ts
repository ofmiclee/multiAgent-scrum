import {betterAuth} from 'better-auth';
import type {Pool} from 'pg';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {readBoundedJson} from './request.ts';
import {AsyncLocalStorage} from 'node:async_hooks';
import {githubTransport} from './github-transport.ts';
import type {GithubRelay} from './github-relay.ts';
import {readPersonalProfile} from './profile.ts';

export type IdentityPrincipal = {id: string; name: string};
export type IdentityService = ReturnType<typeof createIdentityService>;
export type IdentityMail = {kind:'verify-email'|'reset-password';to:string;url:string};
export type IdentityDelivery = {mode:'local'|'email';send:(message:IdentityMail)=>Promise<void>;onError?:()=>void};
export type GithubFailureStage='state'|'exchange'|'profile'|'account'|'callback';
export type GithubDiagnostic={phase:'input'|'provider'|'exception'|'exchange'|'state'|'transport';operation?:'exchange'|'profile'|'email';attempt?:number;status?:number;errorType?:string;code?:string;elapsedMs?:number;frames?:string[];reason?:'invalid_query'|'cookie_too_large'|'cookie_mismatch'|'verification_missing'|'expired'|'invalid_state'|'unknown';checks?:Record<string,boolean>;extraFields?:string[]};
const prefix = '/api/identity';
const loginSchema = z.object({email:z.email().max(254),password:z.string().min(1).max(128)}).strict();
const provisionSchema = loginSchema.extend({name:z.string().trim().min(1).max(120),password:z.string().min(12).max(128)}).strict();
const signInSchema=loginSchema.extend({rememberMe:z.boolean().optional()}).strict();
const tokenSchema=z.string().min(1).max(4096);
const emailSchema=z.object({email:z.email().max(254)}).strict();
const lifecycleSchemas:Record<string,z.ZodType>={
  '/sign-up/email':provisionSchema,
  '/send-verification-email':emailSchema,
  '/verify-email':z.object({token:tokenSchema}).strict(),
  '/request-password-reset':emailSchema,
  '/reset-password':z.object({token:tokenSchema,newPassword:z.string().min(12).max(128)}).strict(),
};

function validatedOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port))) throw Error();
    return url;
  } catch {throw Error('Identity requires an exact HTTPS origin or explicit loopback development origin');}
}
function json(status: number, value: unknown) {
  return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
function error(status: number) {return json(status,{error:{code:status===503?'identity_unavailable':'identity_denied'}});}

/** Independent MAS identity. No CloudBase credentials or preview identities.
 * The supplied pool is lifecycle-owned by the host; this module never runs DDL. */
export function createIdentityService(options: {pool: Pool; origin: string; secret: string;mail?:IdentityDelivery;github?:{clientId:string;clientSecret:string;relay?:GithubRelay};onGithubFailure?:(stage:GithubFailureStage)=>void;onGithubDiagnostic?:(event:GithubDiagnostic)=>void}) {
  const origin = validatedOrigin(options.origin);
  if (!/^[a-f0-9]{64}$/i.test(options.secret) || new Set(options.secret).size < 8)
    throw Error('Identity requires a securely generated 32-byte hex secret');
  if (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')
    throw Error('Production identity requires HTTPS');
  if(options.mail?.mode==='local' && (process.env.NODE_ENV==='production'||origin.hostname!=='127.0.0.1'))
    throw Error('Local mail capture requires loopback development');
  if(options.github&&[options.github.clientId,options.github.clientSecret].some(value=>!value||value.length>512||/\s/.test(value)))
    throw Error('GitHub identity configuration is incomplete or invalid');
  const deliveryContext=new AsyncLocalStorage<{failed:boolean}>();
  const githubContext=new AsyncLocalStorage<{startedAt:number;signal:AbortSignal}>();
  const diagnose=(event:GithubDiagnostic)=>{try{options.onGithubDiagnostic?.(event);}catch{/* Diagnostics never alter login. */}};
  const diagnoseException=(error:unknown)=>{
    const e=error as {name?:string;code?:string;cause?:{code?:string};stack?:string};
    const codes=['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','ETIMEDOUT','ECONNREFUSED','ECONNRESET','ENOTFOUND','42703','42P01','23502','23505','23503'];
    const code=codes.find(code=>code===e?.code||code===e?.cause?.code);
    const errorType=['TypeError','Error','SyntaxError','TimeoutError','AbortError','APIError'].find(name=>name===e?.name)??'unknown';
    // Only source filenames and positions, not error messages or full paths.
    const frames=typeof e?.stack==='string'?[...e.stack.matchAll(/\/([a-zA-Z0-9_.-]+\.(?:mjs|js|ts)):(\d+):(\d+)/g)].slice(0,4).map(m=>m[1]+':'+m[2]+':'+m[3]):[];
    diagnose({phase:'exception',errorType,...(code?{code}:{}),frames});
  };
  const send=async(kind:IdentityMail['kind'],to:string,token:string)=>{
    try {await options.mail!.send({kind,to,url:origin.origin+'/#'+kind+'='+encodeURIComponent(token)});}
    catch {
      const current=deliveryContext.getStore();if(current)current.failed=true;
      // Operator-only health signal, deliberately without recipient/token details.
      try {options.mail?.onError?.();}catch{/* Diagnostic sinks cannot alter the public privacy contract. */}
      throw Error('Identity mail delivery unavailable');
    }
  };
  const auth = betterAuth({
    appName:'MultiAgent-Scrum',baseURL:origin.origin,basePath:prefix,secret:options.secret,
    database:options.pool,trustedOrigins:[origin.origin],
    telemetry:{enabled:false},experimental:{instrumentation:{enabled:false}},
    // Replace (never supplement) the library's raw logger. In particular its
    // exchange errors can contain token response bodies and credential URLs.
    logger:{level:'error',log:(_level,message,...args:unknown[])=>{
      const context=githubContext.getStore();if(!context)return;
      try{
        const e=args[0] as {code?:unknown;error?:unknown;status?:unknown;name?:unknown;message?:unknown;cause?:{code?:unknown}}|undefined;
        const elapsedMs=Math.max(0,Math.min(1200000,Date.now()-context.startedAt));
        if(message==='GitHub OAuth token exchange failed:'||message===''){
          const codes=['bad_verification_code','incorrect_client_credentials','redirect_uri_mismatch','unsupported_grant_type','unverified_user_email','access_denied','temporarily_unavailable','server_error','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ETIMEDOUT','ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN'];
          const code=codes.find(code=>code===e?.error||code===e?.code||code===e?.cause?.code)??'unknown';
          const errorType=['TypeError','Error','SyntaxError','TimeoutError','AbortError'].find(name=>name===e?.name);
          const status=typeof e?.status==='number'&&Number.isInteger(e.status)&&e.status>=100&&e.status<=599?e.status:undefined;
          diagnose({phase:'exchange',code,elapsedMs,...(errorType?{errorType}:{}),...(status?{status}:{})});
        }else if(message==='Failed to parse state'){
          const reason=e?.message==='State mismatch: State not persisted correctly'||e?.message==='State mismatch: auth state cookie not found'?'cookie_mismatch'
            :e?.message==='State mismatch: verification not found'?'verification_missing'
            :e?.message==='Invalid state: request expired'?'expired'
            :e?.code==='state_invalid'?'invalid_state':'unknown';
          diagnose({phase:'state',reason,elapsedMs});
        }
      }catch{/* Logging must never alter authentication or fall back to raw output. */}
    }},
    onAPIError:{onError(error){if(githubContext.getStore())throw error;}},
    user:{modelName:'mas_identity_user',validateUserInfo:({user,source})=>{
      if(source.method==='oauth'&&(source.oauth?.providerId!=='github'||user.emailVerified!==true))
        return {error:'verified_identity_required'};
    }},
    account:{modelName:'mas_identity_account',accountLinking:{enabled:false},encryptOAuthTokens:true},
    ...(options.github?{socialProviders:{github:{clientId:options.github.clientId,clientSecret:options.github.clientSecret}}}:{}),
    plugins:options.github?[githubTransport({credentials:options.github,relay:options.github.relay,diagnose,signal:()=>{
      const context=githubContext.getStore();if(!context)throw Error('GitHub callback context required');return context.signal;
    }})]:[],
    verification:{modelName:'mas_identity_verification'},
    emailAndPassword:{enabled:true,minPasswordLength:12,maxPasswordLength:128,autoSignIn:false,
      requireEmailVerification:!!options.mail,revokeSessionsOnPasswordReset:true,resetPasswordTokenExpiresIn:1800,
      ...(options.mail?{sendResetPassword:async({user,token}:{user:{email:string};token:string})=>send('reset-password',user.email,token)}:{}),
    },
    ...(options.mail?{emailVerification:{sendOnSignUp:true,sendOnSignIn:false,autoSignInAfterVerification:false,expiresIn:3600,
      sendVerificationEmail:async({user,token}:{user:{email:string};token:string})=>send('verify-email',user.email,token),
    }}:{}),
    session:{modelName:'mas_identity_session',expiresIn:86400,disableSessionRefresh:true,cookieCache:{enabled:false}},
    rateLimit:{enabled:true,storage:'database',modelName:'mas_identity_rate_limit',window:60,max:60,
      customRules:Object.fromEntries(['/sign-in/email','/sign-in/social','/callback/github',...Object.keys(lifecycleSchemas)].map(path=>[path,{window:60,max:10}]))},
    advanced:{
      cookiePrefix:'mas_identity_'+createHash('sha256').update(origin.origin).digest('hex').slice(0,16),
      useSecureCookies:origin.protocol==='https:',
      defaultCookieAttributes:{httpOnly:true,sameSite:'strict',path:'/'},
      // Only the short-lived OAuth state cookie can accompany GitHub's navigation.
      cookies:{state:{attributes:{sameSite:'lax'}}},
      crossSubDomainCookies:{enabled:false},
      ipAddress:{ipAddressHeaders:['x-mas-internal-peer']},
    },
  });

  async function principal(headers: Headers): Promise<IdentityPrincipal | null> {
    const cookie = headers.get('cookie') ?? '';
    if (!cookie || cookie.length > 8192) return null;
    // Never forward caller identity/proxy headers into the authentication library.
    const session = await auth.api.getSession({headers:new Headers({cookie}),query:{disableCookieCache:true}});
    return session && (!options.mail||session.user.emailVerified) ? readPersonalProfile(options.pool,session.user.id) : null;
  }

  async function handle(request: Request) {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin.origin) return error(403);
      if(options.github&&url.pathname===prefix+'/callback/github'){
        if(request.method!=='GET')return error(405);
        const fail=origin.origin+'/#github-login=failed';
        const redirect=(location:string,response?:Response)=>{
          if(location===fail&&options.onGithubFailure){
            let stage:GithubFailureStage='callback';
            try{
              const code=new URL(response?.headers.get('location')??'',origin.origin).searchParams.get('error')??'';
              if(['state_mismatch','state_not_found','state_invalid','state_security_mismatch'].includes(code))stage='state';
              else if(code==='invalid_code')stage='exchange';
              else if(['unable_to_get_user_info','email_not_found'].includes(code))stage='profile';
              else if(['unable_to_link_account','email_does_not_match','email_not_verified','verified_identity_required'].includes(code))stage='account';
              // Diagnostic sinks receive only our fixed categories, never raw
              // provider errors, URLs, authorization codes, profiles or cookies.
              options.onGithubFailure(stage);
            }catch{/* Diagnostics must not alter authentication outcomes. */}
          }
          const result=new Response(null,{status:303,headers:{Location:location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
          for(const cookie of response?.headers.getSetCookie()??[])result.headers.append('Set-Cookie',cookie);
          return result;
        };
        // GitHub may return RFC 9207's issuer. Accept only its exact published
        // OAuth issuer, never a caller-selected provider or redirect destination.
        const allowedFields=['state','code','error','error_description','error_uri','iss'];
        const entries=[...url.searchParams];
        const invalidIssuer=url.searchParams.has('iss')&&url.searchParams.get('iss')!=='https://github.com/login/oauth';
        if(url.hash||url.search.length>8192||invalidIssuer||entries.some(([key,value])=>!allowedFields.includes(key)||!value||value.length>4096)||
          new Set(entries.map(([key])=>key)).size!==entries.length||!url.searchParams.get('state')||
          (!url.searchParams.get('code')&&!url.searchParams.get('error'))||
          (url.searchParams.has('code')&&url.searchParams.has('error'))||(request.headers.get('cookie')??'').length>8192){
          diagnose({phase:'input',reason:(request.headers.get('cookie')??'').length>8192?'cookie_too_large':'invalid_query',checks:{
            hash:!!url.hash,queryTooLong:url.search.length>8192,invalidIssuer,unknownKey:entries.some(([key])=>!allowedFields.includes(key)),
            emptyValue:entries.some(([,value])=>!value),valueTooLong:entries.some(([,value])=>value.length>4096),duplicate:new Set(entries.map(([key])=>key)).size!==entries.length,
            missingState:!url.searchParams.get('state'),missingResult:!url.searchParams.get('code')&&!url.searchParams.get('error'),bothResults:url.searchParams.has('code')&&url.searchParams.has('error'),
          },extraFields:entries.filter(([key])=>['scope','iss','authuser','prompt','session_state','user','error_subtype','error_message','installation_id','setup_action'].includes(key)).map(([key])=>key)});
          return redirect(fail);
        }
        try {
          const response=await githubContext.run({startedAt:Date.now(),signal:AbortSignal.timeout(25_000)},()=>auth.handler(new Request(url,{headers:{Cookie:request.headers.get('cookie')??'','x-mas-internal-peer':'127.0.0.1'}})));
          diagnose({phase:'provider',status:response.status});
          return redirect(response.headers.get('location')===origin.origin+'/'?origin.origin+'/':fail,response);
        }catch(error){diagnoseException(error);return redirect(fail);}
      }
      if (url.search || url.hash) return error(400);
      if (request.headers.get('sec-fetch-site') === 'cross-site') return error(403);
      if(url.pathname===prefix+'/options'&&request.method==='GET')return json(200,{
        registration:!!options.mail,passwordReset:!!options.mail,delivery:options.mail?.mode??'disabled',
        ...(options.github?{githubLogin:true}:{}),
      });
      if (url.pathname === prefix+'/session' && request.method === 'GET') {
        const user = await principal(request.headers);
        return user ? json(200,{user}) : error(401);
      }
      const path=url.pathname.slice(prefix.length);
      if(!url.pathname.startsWith(prefix+'/'))return error(404);
      if(path==='/github/start'&&options.github){
        if(request.method!=='POST')return error(405);
        if(request.headers.get('origin')!==origin.origin)return error(403);
        z.object({}).strict().parse(await readBoundedJson(request));
        const response=await auth.handler(new Request(origin.origin+prefix+'/sign-in/social',{
          method:'POST',headers:{'Content-Type':'application/json',Origin:origin.origin,'x-mas-internal-peer':'127.0.0.1'},
          body:JSON.stringify({provider:'github',callbackURL:origin.origin+'/',errorCallbackURL:origin.origin+'/#github-login=failed',disableRedirect:true}),
        }));
        if(!response.ok)return error(response.status===429?429:503);
        const body=await response.json(),target=new URL(body.url);
        if(target.origin!=='https://github.com'||target.pathname!=='/login/oauth/authorize'||target.username||target.password)return error(503);
        const result=json(200,{url:target.href});
        for(const cookie of response.headers.getSetCookie())result.headers.append('Set-Cookie',cookie);
        return result;
      }
      const schema=path==='/sign-in/email'?signInSchema:path==='/sign-out'?z.object({}).strict():options.mail?lifecycleSchemas[path]:undefined;
      if(!schema)return error(404);
      if (request.method !== 'POST') return error(405);
      if (request.headers.get('origin') !== origin.origin) return error(403);
      const input = await readBoundedJson(request);
      const body=schema.parse(input);
      const verify=path==='/verify-email';
      if(verify)url.searchParams.set('token',(body as {token:string}).token);
      const delivery={failed:false};
      const response = await deliveryContext.run(delivery,()=>auth.handler(new Request(url,{
        method:verify?'GET':'POST',headers:{'Content-Type':'application/json',Origin:origin.origin,
          // Resend is a public recovery action, independent of any existing
          // signed-in account. Do not trigger native session/email matching.
          Cookie:path==='/send-verification-email'?'':request.headers.get('cookie') ?? '',
          // Conservative global request bucket until trusted proxy topology is deployed.
          'x-mas-internal-peer':'127.0.0.1'},body:verify?undefined:JSON.stringify(body),
      })));
      // Acknowledges the request, never delivery. Keep failures private so a mail
      // outage cannot distinguish registered from unknown email addresses.
      if(delivery.failed)return json(200,{ok:true});
      if (!response.ok) return error(verify&&response.status===401?400:[400,401,403,429].includes(response.status)?response.status:503);
      // Better Auth sign-in JSON includes a bearer token; MAS only exposes cookies.
      const result = json(200,{ok:true});
      for(const cookie of response.headers.getSetCookie())result.headers.append('Set-Cookie',cookie);
      return result;
    } catch(e) {
      return error(e===413?413:e===400 || e instanceof z.ZodError?400:503);
    }
  }

  /** Operator-only provisioning API; deliberately not exposed by handle().
   * Email is an identifier, not verified ownership and never an organization grant. */
  async function provision(input: {email:string;name:string;password:string}): Promise<IdentityPrincipal> {
    try {
      const result = await auth.api.signUpEmail({body:provisionSchema.parse(input)});
      // Public signup APIs deliberately synthesize success for duplicate emails.
      // Operator provisioning must never return a nonexistent synthetic identity.
      const persisted = await options.pool.query('SELECT id FROM mas_identity_user WHERE id=$1',[result.user.id]);
      if (persisted.rowCount !== 1) throw Error();
      return {id:result.user.id,name:result.user.name};
    } catch {throw Error('Identity account provisioning failed');}
  }
  return {handle,principal,provision};
}
