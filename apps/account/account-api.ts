import {z} from 'zod';

export class AccountRequestError extends Error {
  constructor(public readonly status:number){super('Account request failed');}
}

export async function accountRequest<T>(path:string,schema:z.ZodType<T>,options?:{
  body?:object;
  method?:'GET'|'POST'|'DELETE';
  signal?:AbortSignal;
  expectedIdentity?:string;
  taskPresentation?:boolean;
}):Promise<T>{
  const response=await fetch('/api/account'+path,{
    method:options?.method??(options?.body===undefined?'GET':'POST'),
    credentials:'same-origin',
    cache:'no-store',
    signal:options?.signal,
    ...(options?.taskPresentation?{headers:{'X-MAS-Task-Presentation':'1'}}:{}),
    ...(options?.body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(options.body)}),
  });
  if(!response.ok)throw new AccountRequestError(response.status);
  if(options?.expectedIdentity&&response.headers.get('X-MAS-Identity')!==options.expectedIdentity)throw new AccountRequestError(401);
  return schema.parse(await response.json());
}

export function denied(error:unknown):boolean{
  return error instanceof AccountRequestError&&[401,403,404].includes(error.status);
}
