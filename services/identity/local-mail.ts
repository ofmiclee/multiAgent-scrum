import {mkdir,lstat,realpath,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {IdentityDelivery,IdentityMail} from './service.ts';

/** Development mail capture only. Never served over HTTP or sent externally. */
export function createLocalIdentityMail(baseDirectory:string,relativeDirectory:string):IdentityDelivery {
  const components=relativeDirectory.split('/');
  if(!isAbsolute(baseDirectory)||components.some(part=>!part||part==='.'||part==='..'||!/^[a-zA-Z0-9_.-]+$/.test(part))||
    process.env.NODE_ENV==='production')throw Error('Local mail requires a private development directory');
  return {mode:'local',async send(message:IdentityMail){
    try {
      // Resolve only the explicitly trusted base (including OS /tmp aliases).
      // Never recursively mkdir through an unchecked descendant such as .runtime.
      let directory=await realpath(baseDirectory);
      for(const [index,component] of components.entries()){
        directory=join(directory,component);
        try {await mkdir(directory,{mode:0o700});}
        catch(e){if(!(e instanceof Error&&'code'in e&&e.code==='EEXIST'))throw e;}
        const info=await lstat(directory);
        const mask=index===components.length-1?0o077:0o022;
        if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&mask)!==0)throw Error();
      }
      const target=join(directory,randomUUID()+'.json');
      const file=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try {
        await file.writeFile(JSON.stringify({delivery:'local-capture-not-sent',...message},null,2));
        await file.sync();
      }finally{await file.close();}
    }catch{throw Error('Private local mail capture unavailable');}
  }};
}
