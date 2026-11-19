import {useEffect,useRef,useState} from 'react';
import {EditorContent,useEditor,type JSONContent} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import {ImagePlus} from 'lucide-react';
import {z} from 'zod';
import {accountRequest,AccountRequestError} from './account-api';
import {bodyImageReferences,bodyParts} from '../../packages/domain/body-images';
import type {BodyEditorProps} from './BodyEditor';

function documentFor(body:string):JSONContent{
  return {type:'doc',content:body.split('\n').map(line=>{
    const parts=bodyParts(line);
    if(parts.length===1&&'src'in parts[0])return {type:'image',attrs:{src:parts[0].src,alt:'正文图片'}};
    return {type:'paragraph',content:line?[{type:'text',text:line}]:[]};
  })};
}
function bodyFor(doc:JSONContent):string{
  const text=(node:JSONContent):string=>node.type==='text'?node.text??'':node.type==='hardBreak'?'\n':(node.content??[]).map(text).join('');
  return (doc.content??[]).map(node=>node.type==='image'?`![图片](${node.attrs?.src})`:text(node)).join('\n');
}
const extensions=[StarterKit.configure({heading:false,blockquote:false,bulletList:false,orderedList:false,listItem:false,listKeymap:false,codeBlock:false,horizontalRule:false,bold:false,italic:false,strike:false,code:false,link:false,underline:false,trailingNode:false}),Image.configure({allowBase64:false})];

export default function BodyEditorContent({projectId,value,onChange,label,disabled=false,maxLength,onUploading}:BodyEditorProps){
  const fileInput=useRef<HTMLInputElement>(null),uploading=useRef(false),alive=useRef(true);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const latest=useRef({onChange,onUploading,disabled});latest.current={onChange,onUploading,disabled};
  const editor=useEditor({extensions,content:documentFor(value),editorProps:{attributes:{role:'textbox','aria-label':label,'aria-multiline':'true'},
    handlePaste(view,event){
      if(latest.current.disabled||uploading.current)return true;
      const files=Array.from(event.clipboardData?.files??[]);
      if(files.length){void insertFiles(files);return true;}
      const text=event.clipboardData?.getData('text/plain');
      // Never import HTML, remote images, tracking URLs or clipboard styles.
      if(text){view.dispatch(view.state.tr.insertText(text));return true;}return true;
    },
    handleDrop(view,event,_slice,moved){
      if(moved)return false;
      const files=Array.from(event.dataTransfer?.files??[]);if(files.length){void insertFiles(files);return true;}
      const text=event.dataTransfer?.getData('text/plain');if(text&&!latest.current.disabled&&!uploading.current)view.dispatch(view.state.tr.insertText(text));return true;
    },
  },onUpdate({editor}){latest.current.onChange(bodyFor(editor.getJSON()));}});
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{editor?.setEditable(!disabled&&!busy);},[editor,disabled,busy]);
  useEffect(()=>{if(editor&&bodyFor(editor.getJSON())!==value)editor.commands.setContent(documentFor(value),{emitUpdate:false});},[editor,value]);
  async function insertFiles(files:File[]){
    if(!editor||editor.isDestroyed||uploading.current||latest.current.disabled)return;
    if(bodyImageReferences(bodyFor(editor.getJSON())).length+files.length>8){setNotice('正文最多添加 8 张图片。');return;}
    if(files.some(file=>!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>10*1024*1024)){
      setNotice('请选择 PNG、JPEG 或 WebP 图片，单张不超过 10 MB。');return;
    }
    uploading.current=true;setBusy(true);latest.current.onUploading?.(true);setNotice('');
    try{
      for(const file of files){
        const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('Image read failed'));reader.readAsDataURL(file);});
        const result=await accountRequest('/projects/'+projectId+'/body-images',z.object({url:z.string()}).strict(),{body:{id:crypto.randomUUID(),data}});
        if(!alive.current||editor.isDestroyed)return;
        const ref=bodyImageReferences(`![图片](${result.url})`)[0];
        if(!ref||ref.projectId!==projectId)throw Error('Image scope mismatch');
        editor.chain().focus().setImage({src:result.url,alt:'正文图片'}).createParagraphNear().run();
      }
    }catch(error){if(alive.current)setNotice(error instanceof AccountRequestError?({400:'图片格式或尺寸不可用，请选择 PNG、JPEG 或 WebP 图片。',401:'登录已失效，请重新登录后上传。',403:'当前账号无权上传此项目的图片。',404:'图片上传接口暂不可用，请刷新页面后重试。',413:'图片过大，单张图片不能超过 10 MB。',429:'图片空间已满，请稍后重试。'}[error.status]??'图片上传失败，请重新粘贴或选择图片。'):'图片上传失败，请重新粘贴或选择图片。');}
    finally{uploading.current=false;if(alive.current){setBusy(false);latest.current.onUploading?.(false);}}
  }
  return <div className={'body-editor'+(disabled?' is-disabled':'')}>
    <EditorContent editor={editor}/>
    <div className="body-editor-tools"><button type="button" className="icon-button" title="添加图片" aria-label="添加图片" disabled={disabled||busy} onClick={()=>fileInput.current?.click()}><ImagePlus size={18}/></button><span className={value.length>maxLength?'text-error':''}>{busy?'图片上传中…':`${value.length} / ${maxLength}`}</span></div>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';void insertFiles(files);}}/>
    {notice&&<p role="alert" className="notice notice-error">{notice}</p>}
  </div>;
}
