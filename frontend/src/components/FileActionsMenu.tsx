import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const fileMenuItem = 'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-[var(--color-background-subtle)] focus:bg-[var(--color-primary-soft)]';

export function FileActionsMenu({ anchor, label, close, children }: {
  anchor: HTMLButtonElement; label: string; close: () => void; children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const trigger = anchor.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const right = trigger.right + 8;
    const left = right + bounds.width <= window.innerWidth - 12
      ? right : trigger.left - bounds.width - 8;
    setPosition({
      left: Math.max(12, Math.min(left, window.innerWidth - bounds.width - 12)),
      top: Math.max(12, Math.min(trigger.top, window.innerHeight - bounds.height - 12)),
    });
    element.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });

    function outside(event: PointerEvent) {
      const target = event.target as Node;
      if (!element!.contains(target) && !anchor.contains(target)) close();
    }
    function keyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        anchor.focus({ preventScroll: true });
      } else if (event.key === 'Tab') close();
    }
    function scroll(event: Event) {
      if (!(event.target instanceof Node) || !element!.contains(event.target)) close();
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keyboard);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keyboard);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor, close]);

  return createPortal(
    <div ref={menu} id={anchor.getAttribute('aria-controls') || undefined} role="menu" aria-label={'Actions for ' + label}
      style={position}
      className="fixed z-[100] max-h-[calc(100dvh-24px)] w-56 max-w-[calc(100vw-24px)] overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-background-surface)] p-1.5 text-[var(--color-text-secondary)] shadow-xl"
      onClick={event => {
        if ((event.target as HTMLElement).closest('[role="menuitem"]')) close();
      }}
      onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      <div role="presentation" className="truncate border-b border-[var(--color-border)] px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)]">{label}</div>
      <div className="pt-1">{children}</div>
    </div>, document.body,
  );
}
