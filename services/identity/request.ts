/** Bounded JSON shared by the narrow identity/account HTTP surfaces. */
export async function readBoundedJson(request:Request,maxBytes=16_384):Promise<unknown> {
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')??''))throw 400;
  const reader=request.body?.getReader();if(!reader)throw 400;
  const parts:Uint8Array[]=[];let size=0;
  try {
    for(;;){
      const {done,value}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>maxBytes){await reader.cancel();throw 413;}
      parts.push(value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  }catch(e){if(e===413)throw e;throw 400;}
  finally{reader.releaseLock();}
}
