import {useRef,useState} from 'react';
import {Building2,ChevronUp,LogOut} from 'lucide-react';
import {ProfileAvatar} from './PersonalProfile';
import {DropdownMenu,DropdownMenuContent,DropdownMenuItem,DropdownMenuTrigger} from './ui/dropdown-menu';

export default function ProfileMenu({name, image, disabled, onProfile, onOrganizations, onSignOut}: {name: string; image?:string|null; disabled: boolean; onProfile:()=>void; onOrganizations: () => void; onSignOut: () => void}) {
  const [open, setOpen] = useState(false);
  const firstItem=useRef<HTMLButtonElement>(null);
  return <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
    <div className="profile-menu">
      <div className="profile-controls">
        <button className="profile-avatar-button" type="button" aria-label="个人资料" title="个人资料" disabled={disabled} onClick={()=>{setOpen(false);onProfile();}}><ProfileAvatar name={name} image={image}/></button>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button className="profile-trigger" type="button" aria-label="用户菜单" title={name+' · 用户菜单'}><strong>{name}</strong><ChevronUp size={15} aria-hidden="true"/></button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent className="profile-dropdown" aria-label="用户菜单" side="top" align="end" sideOffset={8} collisionPadding={8} loop
        onFocus={event=>{if(event.target===event.currentTarget)firstItem.current?.focus();}}
        onKeyDown={event=>{if(event.key==='Tab'){event.preventDefault();setOpen(false);}}}>
        <DropdownMenuItem asChild disabled={disabled} onSelect={onOrganizations}><button ref={firstItem} type="button" disabled={disabled}><Building2 size={16} aria-hidden="true"/>组织管理</button></DropdownMenuItem>
        <DropdownMenuItem asChild disabled={disabled} onSelect={onSignOut}><button type="button" disabled={disabled}><LogOut size={16} aria-hidden="true"/>退出系统</button></DropdownMenuItem>
      </DropdownMenuContent>
    </div>
  </DropdownMenu>;
}
