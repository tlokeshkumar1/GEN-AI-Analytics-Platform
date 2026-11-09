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
      className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-white/95 backdrop-blur-md border-t border-[#E2E8F0] pb-safe"
    >
      <div className="grid grid-cols-6 items-center h-14 sm:h-16 px-0.5 sm:px-1 max-w-lg mx-auto">
        {tabs.map((tab) => {
          const isActive = activePath === tab.id;
          const isAiTab = tab.id === 'build-your-kpi-graph-studio' || tab.id === 'ai-agents';
          const activeColor = isAiTab ? 'text-[#7C3AED]' : 'text-[#2563EB]';

          return (
            <button
              key={tab.id}
              onClick={() => onNavigate(tab.id)}
              className={`flex flex-col items-center justify-center py-1 px-0.5 rounded-lg transition-colors min-h-[44px] ${
                isActive
                  ? `${activeColor} font-semibold`
                  : 'text-[#64748B] hover:text-[#0F172A]'
              }`}
            >
              <span className={`material-symbols-outlined text-[19px] sm:text-[22px] ${isActive ? 'font-bold' : ''}`}>
                {tab.icon}
              </span>
              <span className={`text-[9px] sm:text-[10px] tracking-tight leading-tight mt-0.5 truncate max-w-[46px] sm:max-w-[54px] ${isActive ? 'font-semibold' : ''}`}>
                {tab.label}
              </span>
            </button>
          );
        })}

        {/* More Menu Trigger */}
        <button
          onClick={onOpenDrawer}
          className="flex flex-col items-center justify-center py-1 px-0.5 rounded-lg transition-colors min-h-[44px] text-[#64748B] hover:text-[#0F172A]"
          aria-label="More navigation items"
        >
          <span className="material-symbols-outlined text-[19px] sm:text-[22px]">
            menu
          </span>
          <span className="text-[9px] sm:text-[10px] tracking-tight leading-tight mt-0.5">
            More
          </span>
        </button>
      </div>
    </nav>
  );
};
