import React from 'react';

interface MobileBottomNavProps {
  activePath: string;
  onNavigate: (path: string) => void;
  onOpenDrawer: () => void;
}

export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  activePath,
  onNavigate,
  onOpenDrawer,
}) => {
  const tabs = [
    { id: 'executive-dashboard', label: 'Executive', icon: 'dashboard' },
    { id: 'ai-agents', label: 'Agents', icon: 'smart_toy' },
    { id: 'build-your-kpi-graph-studio', label: 'Studio', icon: 'query_stats' },
    { id: 'upload-dataset', label: 'Upload Files', icon: 'upload_file' },
    { id: 'data-explorer', label: 'Explorer', icon: 'terminal' },
  ];

  return (
    <nav 
      aria-label="Mobile Bottom Navigation"
      className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-[var(--color-background-surface)]/98 backdrop-blur-md border-t border-[var(--color-border)] pb-safe"
    >
      <div className="grid grid-cols-6 items-center h-14 px-1 max-w-lg mx-auto">
        {tabs.map((tab) => {
          const isActive = activePath === tab.id;
          const isAiTab = tab.id === 'build-your-kpi-graph-studio' || tab.id === 'ai-agents';
          const activeColor = isAiTab ? 'text-[var(--color-ai)]' : 'text-[var(--color-primary)]';

          return (
            <button
              key={tab.id}
              onClick={() => onNavigate(tab.id)}
              className={`flex flex-col items-center justify-center py-1 px-0.5 rounded-[var(--radius-element)] transition-colors min-h-[44px] cursor-pointer ${
                isActive
                  ? `${activeColor} font-medium`
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <span className={`material-symbols-outlined text-[19px] ${isActive ? 'font-semibold' : ''}`}>
                {tab.icon}
              </span>
              <span className={`text-[10px] tracking-tight leading-tight mt-0.5 truncate max-w-[50px] ${isActive ? 'font-medium' : ''}`}>
                {tab.label}
              </span>
            </button>
          );
        })}

        {/* More Menu Trigger */}
        <button
          onClick={onOpenDrawer}
          className="flex flex-col items-center justify-center py-1 px-0.5 rounded-[var(--radius-element)] transition-colors min-h-[44px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] cursor-pointer"
          aria-label="More navigation items"
        >
          <span className="material-symbols-outlined text-[19px]">
            menu
          </span>
          <span className="text-[10px] tracking-tight leading-tight mt-0.5">
            More
          </span>
        </button>
      </div>
    </nav>
  );
};
