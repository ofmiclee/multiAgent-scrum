// Adapted from shadcn/ui (MIT), Copyright (c) 2023 shadcn.
// Source and adaptations: docs/reuse/implementation-provenance.md.
// License: docs/licenses/shadcn-ui.txt.
import type {ComponentProps} from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

export function DropdownMenu(props:ComponentProps<typeof DropdownMenuPrimitive.Root>){
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props}/>;
}

export function DropdownMenuTrigger(props:ComponentProps<typeof DropdownMenuPrimitive.Trigger>){
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props}/>;
}

export function DropdownMenuContent({sideOffset=4,...props}:ComponentProps<typeof DropdownMenuPrimitive.Content>){
  return <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content data-slot="dropdown-menu-content" sideOffset={sideOffset} {...props}/>
  </DropdownMenuPrimitive.Portal>;
}

export function DropdownMenuItem(props:ComponentProps<typeof DropdownMenuPrimitive.Item>){
  return <DropdownMenuPrimitive.Item data-slot="dropdown-menu-item" {...props}/>;
}
