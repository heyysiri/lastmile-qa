'use client';

import type { ComponentProps, ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { X } from 'lucide-react';

// Radix accessibility primitives, as used by shadcn/ui, styled for the studio.
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({ title, description, children }: {
  title: string; description: string; children: ReactNode;
}) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="dialog-overlay" />
    <DialogPrimitive.Content className="dialog-content studio">
      <div className="dialog-heading">
        <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
        <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
      </div>
      {children}
      <DialogPrimitive.Close className="dialog-close" aria-label="Close setup"><X size={19} aria-hidden="true" /></DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>;
}

export const Tabs = TabsPrimitive.Root;
export function TabsList({ children }: { children: ReactNode }) {
  return <TabsPrimitive.List className="workspace-tabs" aria-label="Project workspace">{children}</TabsPrimitive.List>;
}
export function TabsTrigger(props: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger {...props} className="workspace-tab" />;
}
export function TabsContent(props: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content {...props} className="workspace-panel" />;
}
