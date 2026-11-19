import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';

export function projectSecrets(secret:string){
  if(secret.length<32)throw Error('Project files require a stable encryption secret');
  const key=Buffer.from(hkdfSync('sha256',secret,'mas-project-files','v1',32));
  return {
    seal(value:unknown,scope:string){
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
      cipher.setAAD(Buffer.from(scope));
      const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
      return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64');
    },
    open<T>(value:string,scope:string):T{
      const bytes=Buffer.from(value,'base64'),cipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
      cipher.setAAD(Buffer.from(scope));cipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')) as T;
    },
  };
}
export type ProjectSecrets=ReturnType<typeof projectSecrets>;
