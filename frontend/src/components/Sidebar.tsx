import React, { useState, useEffect } from 'react';
import { SidebarSection, sidebarItem } from './SidebarNavigation';
import { ContentFiles } from './ContentFiles';
import { hasAdminRole, getRoleLabel } from '../services/authService';

export interface SidebarProps {
  activePath: string;
  onNavigate: (path: string) => void;
  isOpen: boolean;
  onClose: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  user?: { name?: string; email?: string; role?: string; roles?: string[] } | null;
  onLogout?: () => void;
}

interface NavItem {
  id: string;
  label: string;
  badge: string | null;
  icon: string;
  isAi?: boolean;
}

// 1) AI Dashboards Navigation Items
const DASHBOARD_ITEMS: NavItem[] = [
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
    isAi: true,
  },
  {
    id: 'widgets',
    label: 'Widgets',
    badge: null,
    icon: 'widgets',
  },
  {
    id: 'data-explorer',
    label: 'Data Explorer',
    badge: null,
    icon: 'terminal',
  },
];

// 2) Administration Navigation Items
const ADMIN_ITEMS: NavItem[] = [
  {
    id: 'ai-agents',
    label: 'AI Agents',
    badge: null,
    icon: 'smart_toy',
    isAi: true,
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

// 3) Additional Services Navigation Items
const OTHER_ITEMS: NavItem[] = [
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

/**
 * Astryx Floating Tooltip for Collapsed Sidebar Navigation
 */
const NavTooltip: React.FC<{ label: string; badge?: string | null; group?: string }> = ({
  label,
  badge,
  group,
}) => {
  return (
    <div
      role="tooltip"
      className="absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 px-2.5 py-1.5 rounded-[var(--radius-element)] bg-[#18181B] text-white text-xs font-medium shadow-[var(--shadow-md)] whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-150 border border-white/10 flex items-center gap-1.5"
    >
      <div className="flex flex-col text-left">
        {group && (
          <span className="text-[10px] text-zinc-400 font-semibold uppercase tracking-wider leading-tight">
            {group}
          </span>
        )}
        <span className="font-medium text-white">{label}</span>
      </div>
      {badge && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-[var(--radius-full)] bg-white/20 text-white font-mono font-medium">
          {badge}
        </span>
      )}
      {/* Tiny arrow pointing back to icon */}
      <span className="absolute right-full top-1/2 -translate-y-1/2 -mr-[1px] border-4 border-transparent border-r-[#18181B]" />
    </div>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  activePath,
  onNavigate,
  isOpen,
  onClose,
  isCollapsed: controlledCollapsed,
  onToggleCollapse,
  user,
  onLogout,
}) => {
  // Support persistent internal state if isCollapsed prop is not provided
  const [internalCollapsed, setInternalCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  // Track tablet screen width (768px <= width < 1024px)
  const [isTablet, setIsTablet] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const w = window.innerWidth;
      return w >= 768 && w < 1024;
    }
    return false;
  });

  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth;
      setIsTablet(w >= 768 && w < 1024);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isCollapsed = controlledCollapsed !== undefined ? controlledCollapsed : internalCollapsed;

  // On tablet, sidebar defaults to compact icon-only mode unless opened as a mobile drawer
  const effectiveCollapsed = isTablet ? true : isCollapsed;

  const toggleCollapse = () => {
    if (onToggleCollapse) {
      onToggleCollapse();
    } else {
      setInternalCollapsed(prev => {
        const next = !prev;
        try {
          localStorage.setItem('sidebar_collapsed', String(next));
        } catch {}
        return next;
      });
    }
  };

  const isAdmin = hasAdminRole(user);
  const displayRole = getRoleLabel(user);

  const isAdminActive = ADMIN_ITEMS.some(i => i.id === activePath);
  const isDashboardActive = DASHBOARD_ITEMS.some(i => i.id === activePath);

  const [adminOpen, setAdminOpen] = useState(true);
  const [dashboardsOpen, setDashboardsOpen] = useState(true);

  useEffect(() => {
    if (isAdminActive) setAdminOpen(true);
  }, [isAdminActive]);

  useEffect(() => {
    if (isDashboardActive) setDashboardsOpen(true);
  }, [isDashboardActive]);

  // Render navigation item with black text & black symbols
  const renderNavItem = (item: NavItem, groupName?: string) => {
    const isActive = activePath === item.id;
    const isAiItem = Boolean(item.isAi);

    if (effectiveCollapsed) {
      // Compact / Icon-only mode
      return (
        <div key={item.id} className="relative group flex justify-center py-0.5">
          <button
            type="button"
            onClick={() => {
              onNavigate(item.id);
              onClose();
            }}
            aria-label={item.label}
            className={`w-10 h-10 rounded-[var(--radius-element)] flex items-center justify-center relative transition-all duration-[var(--transition-fast)] cursor-pointer focus-visible:ring-2 focus-visible:ring-black outline-none ${
              isActive
                ? isAiItem
                  ? 'bg-[var(--color-ai-soft)] text-black font-semibold border border-[var(--color-ai-muted)] shadow-[var(--shadow-2xs)]'
                  : 'bg-[var(--color-primary-soft)] text-black font-semibold border border-[var(--color-primary-muted)] shadow-[var(--shadow-2xs)]'
                : 'text-black hover:bg-[var(--color-background-subtle)] border border-transparent'
            }`}
          >
            {/* Active Left Accent Pill Indicator */}
            {isActive && (
              <span
                className={`absolute left-0 top-2 bottom-2 w-1 rounded-r-full ${
                  isAiItem ? 'bg-[var(--color-ai)]' : 'bg-[var(--color-primary)]'
                }`}
              />
            )}

            <span className="material-symbols-outlined text-[19px] text-black">
              {item.icon}
            </span>

            {/* Live Status Badge Pulse Dot */}
            {item.badge === 'Live' && (
              <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[var(--color-success)] ring-2 ring-[var(--color-background-surface)] animate-pulse" />
            )}
          </button>

          {/* Floating Tooltip */}
          <NavTooltip label={item.label} badge={item.badge} group={groupName} />
        </div>
      );
    }

    // Expanded mode
    let badgeClasses = 'bg-[var(--color-background-subtle)] text-black';

    if (item.badge === 'Live') {
      badgeClasses =
        'bg-[var(--color-success-soft)] text-black border border-[var(--color-success-muted)]';
    } else if (isAiItem) {
      badgeClasses = isActive
        ? 'bg-[var(--color-ai-muted)] text-black'
        : 'bg-[var(--color-ai-soft)] text-black';
    } else if (isActive) {
      badgeClasses = 'bg-[var(--color-primary-muted)] text-black';
    }

    return (
      <button
        key={item.id}
        type="button"
        onClick={() => {
          onNavigate(item.id);
          onClose();
        }}
        className={isActive && isAiItem ? sidebarItem(true).replace('bg-[var(--color-primary-soft)]', 'bg-[var(--color-ai-soft)]').replace('border-[var(--color-primary-muted)]', 'border-[var(--color-ai-muted)]') : sidebarItem(isActive)}
      >
        {/* Active Left Accent Pill Indicator */}
        {isActive && (
          <span
            className={`absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full ${
              isAiItem ? 'bg-[var(--color-ai)]' : 'bg-[var(--color-primary)]'
            }`}
          />
        )}

        <div className="flex items-center gap-2.5 min-w-0">
          <span className="material-symbols-outlined text-[17px] text-black shrink-0">
            {item.icon}
          </span>
          <span className="truncate text-black font-medium">{item.label}</span>
        </div>

        {item.badge && (
          <span
            className={`font-label-sm text-[10px] px-1.5 py-0.5 rounded-[var(--radius-full)] shrink-0 font-medium ${badgeClasses}`}
          >
            {item.badge === 'Live' && (
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-success)] mr-1 animate-pulse" />
            )}
            {item.badge}
          </span>
        )}
      </button>
    );
  };

  return (
    <>
      {/* Mobile Backdrop Overlay (< md) */}
      {isOpen && (
        <div
          data-testid="sidebar-backdrop"
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-50 md:hidden transition-opacity duration-200"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Sidebar Container */}
      <aside
        data-testid="application-sidebar"
        aria-label="Application Sidebar"
        className={`fixed left-0 top-0 lg:top-14 bottom-0 bg-[var(--color-background-surface)] border-r border-[var(--color-border)] z-50 md:z-40 flex flex-col justify-between select-none transition-all duration-200 ease-in-out shadow-[var(--shadow-sm)] ${
          effectiveCollapsed ? 'w-[72px]' : 'w-[256px]'
        } ${
          isOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        }`}
      >
        {/* Top Header / Platform Navigation with Toggle Button Beside It */}
        {!effectiveCollapsed ? (
          <div className="px-3 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between shrink-0">
            <span className="text-[11px] uppercase tracking-wider text-black font-bold">
              Platform Navigation
            </span>

            <div className="flex items-center gap-1">
              {/* Mobile Drawer Close Button */}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close navigation"
                className="md:hidden w-7 h-7 rounded-[var(--radius-element)] flex items-center justify-center text-black hover:bg-[var(--color-background-subtle)] transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px] text-black">close</span>
              </button>

              {/* Desktop / Drawer Collapse Toggle Button beside PLATFORM NAVIGATION */}
              <button
                type="button"
                onClick={toggleCollapse}
                title="Collapse sidebar (Ctrl+B)"
                aria-label="Collapse sidebar"
                className="hidden md:flex w-7 h-7 rounded-[var(--radius-element)] items-center justify-center text-black hover:bg-[var(--color-background-subtle)] transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px] text-black">
                  keyboard_double_arrow_left
                </span>
              </button>
            </div>
          </div>
        ) : (
          // Collapsed Mode Header: Expand Button Centered
          <div className="py-2.5 border-b border-[var(--color-border)] flex items-center justify-center shrink-0">
            <button
              type="button"
              onClick={toggleCollapse}
              title="Expand sidebar (Ctrl+B)"
              aria-label="Expand sidebar"
              className="w-8 h-8 rounded-[var(--radius-element)] flex items-center justify-center text-black hover:bg-[var(--color-background-subtle)] transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px] text-black">
                keyboard_double_arrow_right
              </span>
            </button>
          </div>
        )}

        {/* Scrollable Navigation Body */}
        <div className="flex-1 overflow-y-auto min-h-0 py-2 px-2 space-y-1">
          <nav className="flex flex-col gap-1">
            {/* 1) My Files Section */}
            {effectiveCollapsed ? renderNavItem({id:'my-files',label:'My Files',badge:null,icon:'folder'}) :
              <ContentFiles key={user?.email} userKey={user?.email || ''} navigate={(path) => { onNavigate(path); onClose(); }} active={activePath}/>}

            {/* 2) AI Dashboards Section */}
            {effectiveCollapsed ? (
              // Collapsed mode: direct icons with tooltips
              <div className="space-y-0.5">
                {DASHBOARD_ITEMS.map(item => renderNavItem(item, 'AI Dashboards'))}
              </div>
            ) : (
              // Expanded mode: collapsible accordion
              <SidebarSection label="AI Dashboards" icon="dashboard_customize" active={isDashboardActive}
                open={dashboardsOpen} toggle={() => setDashboardsOpen(prev => !prev)}>
                {DASHBOARD_ITEMS.map(item => renderNavItem(item))}
              </SidebarSection>
            )}

            {/* 3) Administration Section (Admin / Admin+User only) */}
            {isAdmin && (
              <>
                {effectiveCollapsed ? (
                  <div className="pt-2 my-1 border-t border-[var(--color-border)] space-y-0.5">
                    {ADMIN_ITEMS.map(item => renderNavItem(item, 'Administration'))}
                  </div>
                ) : (
                  <SidebarSection label="Administration" icon="admin_panel_settings" active={isAdminActive}
                    open={adminOpen} toggle={() => setAdminOpen(prev => !prev)}>
                    {ADMIN_ITEMS.map(item => renderNavItem(item))}
                  </SidebarSection>
                )}
              </>
            )}

            {/* 4) Other Services Section */}
            <div className="pt-2 my-1 border-t border-[var(--color-border)] flex flex-col gap-0.5">
              {!effectiveCollapsed && (
                <div className="px-2 py-1 mb-0.5">
                  <span className="text-[10px] uppercase tracking-wider text-black font-bold">
                    Other Services
                  </span>
                </div>
              )}
              {OTHER_ITEMS.map(item => renderNavItem(item, 'Other Services'))}
            </div>
          </nav>
        </div>

        {/* User Profile & Direct Log Out Footer */}
        <div className="p-2 border-t border-[var(--color-border)] bg-[var(--color-background-surface)] shrink-0 mt-auto pb-safe space-y-1.5">
          {!effectiveCollapsed ? (
            <>
              {/* User Identity Card */}
              <div className="p-2 rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)]">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-black text-white flex items-center justify-center font-medium text-[11px] shrink-0">
                    {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className="text-xs font-semibold text-black truncate"
                      title={user?.name || displayRole}
                    >
                      {user?.name || displayRole}
                    </div>
                    {user?.email && (
                      <div
                        className="text-[10px] text-black truncate font-mono"
                        title={user.email}
                      >
                        {user.email}
                      </div>
                    )}
                  </div>
                  <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-[var(--radius-inner)] shrink-0 bg-neutral-200 text-black">
                    {displayRole}
                  </span>
                </div>
              </div>

              {/* Log Out Button */}
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
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-[var(--radius-element)] text-black hover:text-[var(--color-error)] hover:bg-[var(--color-error-soft)] border border-[var(--color-border)] hover:border-[var(--color-error-muted)] transition-all text-xs font-medium cursor-pointer group"
              >
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px] text-black group-hover:text-[var(--color-error)] transition-colors">
                    logout
                  </span>
                  <span className="font-semibold text-black group-hover:text-[var(--color-error)]">
                    Log Out
                  </span>
                </div>
                <span className="text-[10px] text-black group-hover:text-[var(--color-error)] font-mono transition-colors">
                  End Session
                </span>
              </button>
            </>
          ) : (
            // Collapsed Mode Footer
            <div className="flex flex-col items-center gap-1.5 py-1">
              {/* User Avatar with Tooltip */}
              <div className="relative group cursor-pointer">
                <div className="w-8 h-8 rounded-full bg-black text-white flex items-center justify-center font-medium text-xs shadow-[var(--shadow-2xs)]">
                  {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
                </div>
                <NavTooltip
                  label={user?.name || displayRole}
                  badge={displayRole}
                  group={user?.email || undefined}
                />
              </div>

              {/* Collapsed Log Out Button with Tooltip */}
              <div className="relative group">
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
                  aria-label="Log Out"
                  className="w-8 h-8 rounded-[var(--radius-element)] text-black hover:text-[var(--color-error)] hover:bg-[var(--color-error-soft)] transition-colors flex items-center justify-center cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[17px] text-black">logout</span>
                </button>
                <NavTooltip label="Log Out" badge="End Session" />
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
};
