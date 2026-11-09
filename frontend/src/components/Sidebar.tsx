import React, { useState, useEffect } from 'react';
import { hasAdminRole, getRoleLabel } from '../services/authService';
import { NeovaticLogo } from './NeovaticLogo';

interface SidebarProps {
  activePath: string;
  onNavigate: (path: string) => void;
  isOpen: boolean;
  onClose: () => void;
  user?: { name?: string; email?: string; role?: string; roles?: string[] } | null;
  onLogout?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activePath,
  onNavigate,
  isOpen,
  onClose,
  user,
  onLogout,
}) => {
  // 1) AI Dashboards Dropdown Items
  const dashboardItems = [
    {
      id: 'executive-dashboard',
      label: 'Executive Dashboard',
      badge: null,
      icon: 'dashboard',
    },
    {
      id: 'build-your-kpi-graph-studio',
      label: 'Build Your KPI',
      badge: null,
      icon: 'query_stats',
    },
    {
      id: 'data-explorer',
      label: 'Data Explorer',
      badge: null,
      icon: 'terminal',
    },
  ];

  // 2) Administration Dropdown Items
  const adminItems = [
    {
      id: 'ai-agents',
      label: 'AI Agents',
      badge: null,
      icon: 'smart_toy',
    },
    {
      id: 'upload-dataset',
      label: 'Upload Files',
      badge: null,
      icon: 'upload_file',
    },
    {
      id: 'hanaadmin',
      label: 'HANA Cloud Admin',
      badge: 'Live',
      icon: 'database',
    },
    {
      id: 'user-management',
      label: 'Users',
      badge: null,
      icon: 'person',
    },
    {
      id: 'system-settings',
      label: 'System Management',
      badge: null,
      icon: 'settings',
    },
  ];

  // Other pages left as they are
  const otherItems = [
    {
      id: 'reports-library',
      label: 'Reports Library',
      badge: null,
      icon: 'folder',
    },
    {
      id: 'data-sources',
      label: 'Data Sources',
      badge: null,
      icon: 'database',
    },
  ];

  const isAdmin = hasAdminRole(user);
  const displayRole = getRoleLabel(user);

  const isAdminActive = adminItems.some(i => i.id === activePath);
  const isDashboardActive = dashboardItems.some(i => i.id === activePath);

  const [adminOpen, setAdminOpen] = useState(true);
  const [dashboardsOpen, setDashboardsOpen] = useState(true);

  // Auto-expand dropdown when an item inside it becomes active
  useEffect(() => {
    if (isAdminActive) setAdminOpen(true);
  }, [isAdminActive]);

  useEffect(() => {
    if (isDashboardActive) setDashboardsOpen(true);
  }, [isDashboardActive]);

  const renderNavItem = (item: { id: string; label: string; badge: string | null; icon: string }) => {
    const isActive = activePath === item.id;
    const isAiItem = item.id === 'build-your-kpi-graph-studio' || item.id === 'ai-agents';

    let activeClasses = 'bg-[#EFF6FF] text-[#1D4ED8] font-medium shadow-xs border border-[#BFDBFE]/80';
    let activeIconClass = 'text-[#2563EB]';
    let badgeClasses = 'bg-[#F1F5F9] text-[#475569]';

    if (isActive && isAiItem) {
      activeClasses = 'bg-[#F5F3FF] text-[#6D28D9] font-medium shadow-xs border border-[#DDD6FE]/80';
      activeIconClass = 'text-[#7C3AED]';
    }

    if (item.badge === 'Live') {
      badgeClasses = 'bg-[#DCFCE7] text-[#166534]';
    } else if (isAiItem) {
      badgeClasses = isActive ? 'bg-[#EDE9FE] text-[#6D28D9]' : 'bg-[#F3E8FF] text-[#7C3AED]';
    } else if (isActive) {
      badgeClasses = 'bg-[#DBEAFE] text-[#1D4ED8]';
    }

    return (
      <button
        key={item.id}
        type="button"
        onClick={() => {
          onNavigate(item.id);
          onClose();
        }}
        className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg transition-all text-left cursor-pointer ${
          isActive
            ? activeClasses
            : 'text-[#475569] hover:bg-[#F1F5F9] hover:text-[#0F172A] border border-transparent'
        }`}
      >
        <div className="flex items-center gap-2.5 truncate">
          <span className={`material-symbols-outlined text-[17px] ${isActive ? activeIconClass : 'text-[#64748B]'}`}>
            {item.icon}
          </span>
          <span className="truncate text-xs font-medium">{item.label}</span>
        </div>

        {item.badge && (
          <span
            className={`font-label-sm text-[10px] px-2 py-0.5 rounded-full shrink-0 font-medium ${badgeClasses}`}
          >
            {item.badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      {/* Mobile Backdrop Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 lg:hidden transition-opacity duration-200"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed left-0 top-0 lg:top-16 bottom-0 w-[280px] sm:w-[272px] lg:h-[calc(100vh-4rem)] bg-white border-r border-[#E2E8F0] z-50 lg:z-40 flex flex-col justify-between select-none transition-transform duration-300 ease-in-out ${
          isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Navigation Scrollable Area */}
        <div className="flex-1 overflow-y-auto min-h-0 p-3 sm:p-4">
          {/* Mobile Drawer Header with Close Button */}
          <div className="flex lg:hidden items-center justify-between pb-3 mb-2 border-b border-[#E2E8F0]">
            <div className="flex items-center gap-2.5">
              <NeovaticLogo size={34} showText={false} />
              <div className="flex flex-col">
                <span className="font-headline-sm text-[16px] font-semibold text-[#0F172A]">
                  NEOVATIC
                </span>
                <span className="text-[10px] text-[#64748B] uppercase font-mono">
                  SAP HANA & AI CORE
                </span>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Close navigation"
              className="w-9 h-9 rounded-xl flex items-center justify-center hover:bg-[#F1F5F9] text-[#0F172A] cursor-pointer"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>

          <div className="px-2 py-1 mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">
              Platform Navigation
            </span>
          </div>

          <nav className="flex flex-col gap-1">
            {/* 1) AI Dashboards Dropdown */}
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => setDashboardsOpen(prev => !prev)}
                className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg transition-all text-left cursor-pointer select-none group ${
                  isDashboardActive
                    ? 'bg-slate-100/90 text-[#0F172A] font-semibold'
                    : 'text-[#475569] hover:bg-[#F1F5F9] hover:text-[#0F172A]'
                }`}
                aria-expanded={dashboardsOpen}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className={`material-symbols-outlined text-[18px] transition-colors ${
                    isDashboardActive ? 'text-blue-600' : 'text-[#64748B] group-hover:text-[#0F172A]'
                  }`}>
                    dashboard_customize
                  </span>
                  <span className="font-semibold text-xs tracking-tight truncate">AI Dashboards</span>
                  {isDashboardActive && (
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className={`material-symbols-outlined text-[18px] text-[#64748B] transition-transform duration-200 ${
                    dashboardsOpen ? 'rotate-180' : ''
                  }`}>
                    keyboard_arrow_down
                  </span>
                </div>
              </button>

              {dashboardsOpen && (
                <div className="pl-2 ml-3.5 border-l border-slate-200 flex flex-col gap-0.5 my-1 animate-in fade-in duration-150">
                  {dashboardItems.map(renderNavItem)}
                </div>
              )}
            </div>

            {/* 2) Administration Dropdown (Visible only for Admin or Admin+User, hidden for Only User) */}
            {isAdmin && (
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => setAdminOpen(prev => !prev)}
                  className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg transition-all text-left cursor-pointer select-none group ${
                    isAdminActive
                      ? 'bg-slate-100/90 text-[#0F172A] font-semibold'
                      : 'text-[#475569] hover:bg-[#F1F5F9] hover:text-[#0F172A]'
                  }`}
                  aria-expanded={adminOpen}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`material-symbols-outlined text-[18px] transition-colors ${
                      isAdminActive ? 'text-indigo-600' : 'text-[#64748B] group-hover:text-[#0F172A]'
                    }`}>
                      admin_panel_settings
                    </span>
                    <span className="font-semibold text-xs tracking-tight truncate">Administration</span>
                    {isAdminActive && (
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 shrink-0" />
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className={`material-symbols-outlined text-[18px] text-[#64748B] transition-transform duration-200 ${
                      adminOpen ? 'rotate-180' : ''
                    }`}>
                      keyboard_arrow_down
                    </span>
                  </div>
                </button>

                {adminOpen && (
                  <div className="pl-2 ml-3.5 border-l border-slate-200 flex flex-col gap-0.5 my-1 animate-in fade-in duration-150">
                    {adminItems.map(renderNavItem)}
                  </div>
                )}
              </div>
            )}

            {/* Other Pages Left As They Are */}
            <div className="pt-2 mt-1 border-t border-[#E2E8F0] flex flex-col gap-1">
              <div className="px-2 py-1">
                <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                  Other Services
                </span>
              </div>
              {otherItems.map(renderNavItem)}
            </div>
          </nav>
        </div>

        {/* User Profile & Direct Log Out Button at Bottom of Sidebar */}
        <div className="p-2.5 sm:p-3 border-t border-[#E2E8F0] bg-white shrink-0 mt-auto pb-safe space-y-1.5">
          <div className="p-2 rounded-lg bg-slate-50 border border-slate-200/70">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-full bg-slate-900 text-white flex items-center justify-center font-bold text-[11px] shrink-0 shadow-2xs">
                {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-slate-900 truncate" title={user?.name || 'Analytics Admin'}>
                  {user?.name || 'Analytics Admin'}
                </div>
                <div className="text-[10px] text-slate-500 truncate font-mono" title={user?.email || 'admin@sap.corp'}>
                  {user?.email || 'admin@sap.corp'}
                </div>
              </div>
              <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded shrink-0 ${
                isAdmin ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'
              }`}>
                {displayRole}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => {
              onClose();
              if (onLogout) {
                onLogout();
              } else {
                onNavigate('enterprise-signin');
              }
            }}
            className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-slate-600 hover:text-rose-600 hover:bg-rose-50/70 border border-slate-200/80 hover:border-rose-200 transition-all text-xs font-semibold cursor-pointer group"
          >
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[17px] text-slate-400 group-hover:text-rose-500 group-hover:-translate-x-0.5 transition-all">
                logout
              </span>
              <span>Log Out</span>
            </div>
            <span className="text-[10px] text-slate-400 group-hover:text-rose-400 font-mono transition-colors">End Session</span>
          </button>
        </div>
      </aside>
    </>
  );
};
