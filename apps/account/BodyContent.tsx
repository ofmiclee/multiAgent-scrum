import {bodyParts} from '../../packages/domain/body-images';

export default function BodyContent({body,projectId,className=''}:{body:string;projectId:string;className?:string}){
  return <div className={'body-content '+className}>{bodyParts(body).map((part,index)=>'text'in part
    ?<span key={index}>{part.text}</span>
    :part.projectId===projectId?<img key={index} src={part.src} alt="正文图片" loading="lazy"/>:<span key={index}>[图片不可用]</span>)}</div>;
}
