import {useId,useLayoutEffect,useRef,type ReactNode} from 'react';
import {X} from 'lucide-react';
import './modal.css';

type ModalSize='compact'|'default'|'wide';
type ModalProps={title:string;onClose:()=>void;children:ReactNode;className?:string;size?:ModalSize;describedBy?:string};

export function Modal({title,onClose,children,className='',size='default',describedBy}:ModalProps){
  const dialog=useRef<HTMLDialogElement>(null),titleId='modal-title-'+useId();
  useLayoutEffect(()=>{
    const prior=document.activeElement as HTMLElement|null,node=dialog.current;
    if(!node)return;
    if(!node.open)node.showModal();
    return()=>{if(node.open)node.close();if(prior?.isConnected)prior.focus();};
  },[]);
  return <dialog ref={dialog} className={'app-modal app-modal-'+size+(className?' '+className:'')} aria-labelledby={titleId} aria-describedby={describedBy} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <div className="app-modal-shell">
      <header className="app-modal-header"><h2 id={titleId}>{title}</h2><button className="app-modal-close" type="button" aria-label="关闭" title="关闭" onClick={onClose}><X size={18}/></button></header>
      <div className="app-modal-body">{children}</div>
    </div>
  </dialog>;
}

export function ConfirmDialog({title,description,confirmLabel='确认',busy=false,danger=false,onConfirm,onClose}:{title:string;description:ReactNode;confirmLabel?:string;busy?:boolean;danger?:boolean;onConfirm:()=>void;onClose:()=>void}){
  return <Modal title={title} onClose={onClose} size="compact" className={danger?'app-modal-danger':''}>
    <p className="app-modal-confirm-text">{description}</p>
    <footer className="app-modal-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className={danger?'danger-button':'primary-button'} disabled={busy} onClick={onConfirm}>{busy?'处理中…':confirmLabel}</button></footer>
  </Modal>;
}
