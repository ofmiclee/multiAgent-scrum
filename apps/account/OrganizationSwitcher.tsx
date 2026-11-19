import {useEffect,useId,useRef,useState,type KeyboardEvent} from 'react';
import {Building2,Check,ChevronDown,Plus} from 'lucide-react';

type Organization={id:string;name:string;role:string};
export default function OrganizationSwitcher({organizations,selected,disabled,onSelect,onManage,onCreate}:{
  organizations:Organization[]|null;selected:Organization|null;disabled:boolean;
  onSelect:(organization:Organization)=>void;onManage:()=>void;onCreate:()=>void;
}){
  const [open,setOpen]=useState(false),id=useId();
  const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);
  const initialFocus=useRef<'first'|'last'>('first');
  const items=()=>Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);
  useEffect(()=>{
    if(!open)return;
    const buttons=items();(initialFocus.current==='last'?buttons.at(-1):buttons.find(b=>b.getAttribute('aria-checked')==='true')??buttons[0])?.focus();
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);};
    const escape=(event:globalThis.KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
  },[open]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  function choose(action:()=>void){setOpen(false);trigger.current?.focus();action();}
  function navigate(event:KeyboardEvent<HTMLDivElement>){
    // Let native Tab navigation move focus before removing the focused item.
    if(event.key==='Tab'){requestAnimationFrame(()=>setOpen(false));return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    event.preventDefault();const buttons=items(),index=buttons.findIndex(b=>b===document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
    buttons[next]?.focus();
  }
  return <div className="organization-switcher" ref={root} onBlur={event=>{if(event.relatedTarget instanceof Node&&!event.currentTarget.contains(event.relatedTarget))setOpen(false);}}>
    <button ref={trigger} type="button" className="workspace-context" aria-label={selected?'选择组织：'+selected.name:'选择组织'} aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} disabled={disabled}
      onClick={()=>{initialFocus.current='first';setOpen(value=>!value);}}
      onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();initialFocus.current=event.key==='ArrowUp'?'last':'first';setOpen(true);}}}>
      <span className="workspace-avatar" aria-hidden="true">{selected?Array.from(selected.name.trim())[0]?.toLocaleUpperCase()||'组':<Building2 size={17}/>}</span>
      <span><strong title={selected?.name}>{selected?.name??'选择组织'}</strong></span><ChevronDown size={15} aria-hidden="true"/>
    </button>
    {open&&<div ref={menu} id={id} className="organization-menu" role="menu" aria-label="组织列表" onKeyDown={navigate}>
      {organizations===null?<p role="status">组织未加载，请前往我的组织重试。</p>:organizations.length===0?<p>暂无组织</p>:organizations.map(organization=><button key={organization.id} type="button" role="menuitemradio" aria-label={organization.name} aria-checked={selected?.id===organization.id} tabIndex={-1} onClick={()=>choose(()=>onSelect(organization))}>
        <span className="organization-menu-avatar" aria-hidden="true">{Array.from(organization.name.trim())[0]?.toLocaleUpperCase()||'组'}</span><span className="organization-menu-name" title={organization.name}>{organization.name}</span>{selected?.id===organization.id&&<Check size={14} aria-hidden="true"/>}
      </button>)}
      <div className="organization-menu-actions" role="none">
        <button type="button" role="menuitem" tabIndex={-1} onClick={()=>choose(onManage)}><Building2 size={15} aria-hidden="true"/>我的组织</button>
        <button type="button" role="menuitem" tabIndex={-1} disabled={organizations===null} onClick={()=>choose(onCreate)}><Plus size={15} aria-hidden="true"/>新建组织</button>
      </div>
    </div>}
  </div>;
}
