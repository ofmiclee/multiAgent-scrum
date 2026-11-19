import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Tooltip,TooltipContent,TooltipTrigger} from './ui/tooltip';
import InfoMark from './InfoMark';

/** Explanations only; actions and consent stay in the surrounding page. */
export default function HelpTip({label,children}:{label:string;children:ReactNode}){
  const button=useRef<HTMLButtonElement>(null),pointerOpen=useRef(false),[open,setOpen]=useState(false);
  useEffect(()=>{
    if(!open)return;
    const observer=new MutationObserver(()=>{if(button.current?.closest('[hidden]'))setOpen(false);});
    observer.observe(document.body,{subtree:true,attributes:true,attributeFilter:['hidden']});
    return()=>observer.disconnect();
  },[open]);
  return <Tooltip open={open} onOpenChange={setOpen}>
    <TooltipTrigger ref={button} type="button" className="help-tip-button" aria-label={label} onPointerDown={()=>{pointerOpen.current=open;}} onClick={event=>{event.preventDefault();setOpen(event.detail===0?!open:!pointerOpen.current);}}><InfoMark/></TooltipTrigger>
    <TooltipContent className="help-tip" side="bottom" align="start" collisionPadding={8} container={button.current?.closest('dialog')??undefined}>{children}</TooltipContent>
  </Tooltip>;
}
