// Adapted from shadcn/ui (MIT), Copyright (c) 2023 shadcn.
// Source and adaptations: docs/reuse/implementation-provenance.md.
// License: docs/licenses/shadcn-ui.txt.
import type {ComponentProps} from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

export function TooltipProvider({delayDuration=0,...props}:ComponentProps<typeof TooltipPrimitive.Provider>){
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delayDuration={delayDuration} {...props}/>;
}

export function Tooltip(props:ComponentProps<typeof TooltipPrimitive.Root>){
  return <TooltipPrimitive.Root data-slot="tooltip" {...props}/>;
}

export function TooltipTrigger(props:ComponentProps<typeof TooltipPrimitive.Trigger>){
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props}/>;
}

export function TooltipContent({sideOffset=8,container,...props}:ComponentProps<typeof TooltipPrimitive.Content>&Pick<ComponentProps<typeof TooltipPrimitive.Portal>,'container'>){
  return <TooltipPrimitive.Portal container={container}>
    <TooltipPrimitive.Content data-slot="tooltip-content" sideOffset={sideOffset} {...props}/>
  </TooltipPrimitive.Portal>;
}
