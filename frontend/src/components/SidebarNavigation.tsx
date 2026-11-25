import type { ReactNode } from 'react';

export const sidebarChildren = 'pl-2 ml-3.5 border-l border-[var(--color-border)] flex flex-col gap-0.5 my-1';
export const sidebarItem = (active = false) =>
  `w-full flex items-center justify-between px-2.5 py-1.5 rounded-[var(--radius-element)] transition-all duration-[var(--transition-fast)] text-left cursor-pointer text-xs relative group focus-visible:ring-2 focus-visible:ring-black outline-none ${active
    ? 'bg-[var(--color-primary-soft)] text-black font-semibold border border-[var(--color-primary-muted)] shadow-[var(--shadow-2xs)]'
    : 'text-black hover:bg-[var(--color-background-subtle)] border border-transparent font-medium'}`;

export function SidebarSection({ label, icon, active, open, toggle, children }: {
  label: string; icon: string; active: boolean; open: boolean; toggle: () => void; children?: ReactNode;
}) {
  return <div className="flex flex-col">
    <button type="button" onClick={toggle} aria-expanded={open} aria-label={label}
      className={`w-full flex items-center justify-between px-2 py-1.5 rounded-[var(--radius-element)] transition-all duration-[var(--transition-fast)] text-left cursor-pointer select-none group text-xs ${active
        ? 'bg-[var(--color-background-subtle)] text-black font-semibold'
        : 'text-black hover:bg-[var(--color-background-subtle)] font-medium'}`}>
      <div className="flex items-center gap-2.5 min-w-0">
        <span aria-hidden className="material-symbols-outlined text-[17px] text-black shrink-0">{icon}</span>
        <span className="truncate tracking-tight text-black font-semibold">{label}</span>
        {active && <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] shrink-0" />}
      </div>
      <span aria-hidden className={`material-symbols-outlined text-[16px] text-black transition-transform duration-150 shrink-0 ${open ? 'rotate-180' : ''}`}>keyboard_arrow_down</span>
    </button>
    {open && <div className={sidebarChildren}>{children}</div>}
  </div>;
}
