// A deliberately small text + image format, not HTML or general Markdown.
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const bodyImageUrl=(projectId:string,id:string)=>`/api/account/projects/${projectId}/body-images/${id}`;
export function bodyParts(body:string):({text:string}|{src:string;projectId:string;id:string})[]{
  const pattern=new RegExp(`!\\[图片\\]\\((/api/account/projects/(${uuid})/body-images/(${uuid}))\\)`,'g');
  const parts:ReturnType<typeof bodyParts>=[];let offset=0;
  for(const match of body.matchAll(pattern)){
    if(match.index!>offset)parts.push({text:body.slice(offset,match.index)});
    parts.push({src:match[1],projectId:match[2],id:match[3]});offset=match.index!+match[0].length;
  }
  if(offset<body.length)parts.push({text:body.slice(offset)});
  return parts;
}
export function bodyImageReferences(body:string){return bodyParts(body).filter(p=>'src'in p);}

// Existing Runner adapters carry text, not authenticated browser image bytes.
export function bodyImageTransportNote(body:string){
  return bodyImageReferences(body).length?'\nAttached image references are not image pixels. This text-only Runner input cannot inspect these private images. Do not guess their contents or claim to have viewed them; identify missing visual requirements for human clarification.\n':'';
}
