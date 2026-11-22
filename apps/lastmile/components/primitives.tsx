'use client';

import { useRef, type ComponentProps, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { X } from 'lucide-react';

// Radix accessibility primitives, as used by shadcn/ui, styled for the studio.
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({ title, description, children }: {
  title: string; description: string; children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="dialog-overlay" />
    <DialogPrimitive.Content ref={content} className="dialog-content studio" onKeyDownCapture={event => {
      if (event.key !== 'Tab') return;
      const controls = [...(content.current?.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,summary,[tabindex]') ?? [])]
        .filter(element => element.getClientRects().length && !element.matches(':disabled,[role="tablist"]')
          && (element.tabIndex >= 0 || element.matches('[role="tab"][aria-selected="true"]')));
      const first = controls[0], last = controls.at(-1);
      if (first && last && ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last))) {
        event.preventDefault(); event.stopPropagation(); (event.shiftKey ? last : first).focus();
      }
    }} onOpenAutoFocus={event => {
      // Start on the first field instead of the connection tabs.
      const field = content.current?.querySelector<HTMLElement>('[data-autofocus]');
      if (field) { event.preventDefault(); field.focus(); }
    }}>
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
export function TabsList({ children, label = 'Project workspace' }: { children: ReactNode; label?: string }) {
  return <TabsPrimitive.List className="workspace-tabs" aria-label={label}>{children}</TabsPrimitive.List>;
}
export function TabsTrigger(props: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger {...props} className="workspace-tab" />;
}
export function TabsContent(props: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content {...props} className="workspace-panel" />;
}
