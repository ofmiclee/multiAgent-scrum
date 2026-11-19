import type {IncomingMessage,ServerResponse} from 'node:http';
import {readFile,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {join,sep,extname} from 'node:path';
import {createIdentityHttpHandler} from '../identity/http.ts';
import {storyMutationPath} from './story-routes.ts';
import {publicationMutationPath} from './task-publication-routes.ts';
import {bodyImageUploadPath,bodyImageUploadLimit} from './body-images.ts';
import {directTaskMutationPath} from './direct-tasks.ts';
import {profileUploadLimit} from './profile.ts';
import {CONVERSATION_MAX_BYTES} from '../../packages/domain/task-conversation.ts';

export function createAccountWebHandler(app:{handle:(request:Request)=>Promise<Response>},origin:string,directory:string,downloadDirectory?:string){
  const configured=new URL(origin),api=createIdentityHttpHandler(app,origin,{bodyImages:true,profileImages:true,bodyLimit:target=>
    target.method==='POST'&&!target.search
      ?target.pathname==='/api/account/profile'?profileUploadLimit:bodyImageUploadPath(target.pathname)?bodyImageUploadLimit:(storyMutationPath(target.pathname)||publicationMutationPath(target.pathname)||directTaskMutationPath(target.pathname))?96*1024
        :/^\/api\/account\/projects\/[^/]+\/tasks\/[^/]+\/comments$/.test(target.pathname)?32_768:/^\/api\/account\/projects\/[^/]+\/files(?:\/[^/]+)?$/.test(target.pathname)?96*1024:16_384
      :16_384,
  });
  const runnerApi=createIdentityHttpHandler(app,origin,{nativeRunner:true,bodyLimit:target=>
    target.method==='POST'&&!target.search?(/^\/api\/runner\/(repositories|code-artifacts)\/chunk$/.test(target.pathname)?384*1024:target.pathname==='/api/runner/tasks/finish'?96*1024:target.pathname==='/api/runner/tasks/progress'?CONVERSATION_MAX_BYTES+2048:target.pathname==='/api/runner/tasks/poll'?16384:8192):8192});
  const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
  return async(req:IncomingMessage,res:ServerResponse)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:*; img-src 'self' data: https://avatars.githubusercontent.com; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const reject=(status:number)=>{req.resume();res.writeHead(status,{'Content-Type':'application/json',Connection:'close'});res.end(JSON.stringify({error:{code:'page_unavailable'}}));};
    if(req.headers.host!==configured.host){reject(403);return;}
    if(!req.url?.startsWith('/')||req.url.startsWith('//')||/[\\#\s]/.test(req.url)){reject(400);return;}
    const url=new URL(req.url,origin);
    if(url.pathname.startsWith('/api/')){
      const githubReturn=req.method==='GET'&&url.pathname==='/api/identity/callback/github';
      if(req.headers['sec-fetch-site']==='cross-site'&&!githubReturn){reject(403);return;}
      await (url.pathname.startsWith('/api/runner/')?runnerApi:api)(req,res);return;
    }
    // Webmail links may navigate here cross-site. Static GET/HEAD grants no
    // identity; the loaded page must still submit to the same-origin API.
    if(!['GET','HEAD'].includes(req.method??'')||url.search){reject(404);return;}
    if(downloadDirectory&&url.pathname==='/downloads/MultiAgent-Scrum-Runner-macos-arm64.dmg'){
      let file;
      try{
        const root=await realpath(downloadDirectory);
        const {filename}=JSON.parse(await readFile(join(root,'runner-release.json'),'utf8'));
        if(typeof filename!=='string'||!/^MultiAgent-Scrum-Runner-\d+\.\d+\.\d+-macos-arm64\.dmg$/.test(filename))throw Error('Invalid Runner release');
        file=await open(join(root,filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const info=await file.stat();
        if(!info.isFile()||info.size>400*1024*1024)throw Error('Invalid download');
        res.writeHead(200,{'Content-Type':'application/x-apple-diskimage','Content-Length':info.size,'Content-Disposition':`attachment; filename="${filename}"`});
        req.resume();
        if(req.method==='HEAD')res.end();else await pipeline(file.createReadStream({autoClose:false}),res);
      }catch{if(!res.headersSent)reject(404);else res.destroy();}
      finally{await file?.close();}
      return;
    }
    if(url.pathname==='/downloads/Configure-Agent-API-Key.zip'){
      try{
        const root=await realpath(directory),file=await realpath(join(root,'downloads/Configure-Agent-API-Key.zip'));
        if(!file.startsWith(root+sep)){reject(404);return;}
        const bytes=await readFile(file);
        if(bytes.length>8192)throw Error('Invalid helper');
        res.writeHead(200,{'Content-Type':'application/zip','Content-Length':bytes.length,'Content-Disposition':'attachment; filename="Configure-Agent-API-Key.zip"'});
        req.resume();res.end(req.method==='HEAD'?undefined:bytes);
      }catch{if(!res.headersSent)reject(404);else res.end();}
      return;
    }
    const name=url.pathname==='/'||url.pathname==='/index.html'?'index.html':
      url.pathname==='/shadcn-radix-notices.txt'?'shadcn-radix-notices.txt':
      /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css|svg|woff2)$/.test(url.pathname)?url.pathname.slice(1):null;
    if(!name){reject(404);return;}
    try {
      const root=await realpath(directory),file=await realpath(join(root,name));
      if(!file.startsWith(root+sep)){reject(404);return;}
      const bytes=await readFile(file);
      res.writeHead(200,{'Content-Type':types[extname(file)],'Content-Length':bytes.length});
      req.resume();res.end(req.method==='HEAD'?undefined:bytes);
    }catch{if(!res.headersSent)reject(404);else res.end();}
  };
}
