import React, { useState } from 'react';
import { hasAdminRole, getRoleLabel } from '../services/authService';
import { NeovaticLogo } from './NeovaticLogo';

interface HeaderProps {
  onOpenCommandPalette: () => void;
  onNavigate: (path: string) => void;
  onToggleSidebar: () => void;
  activePath: string;
  onLogout?: () => void;
  user?: {
    name?: string;
    email?: string;
    roles?: string[];
    role?: string;
  } | null;
}

export const Header: React.FC<HeaderProps> = ({
  onOpenCommandPalette,
  onNavigate,
  onToggleSidebar,
  activePath,
  onLogout,
  user,
}) => {
  const [profileOpen, setProfileOpen] = useState(false);

  const isAdmin = hasAdminRole(user);
  const roleLabel = getRoleLabel(user);
  const roleSubtitle = isAdmin
    ? (roleLabel === 'Admin+User' ? 'Administrator & User' : 'Administrator')
    : 'Standard User';

  const isHomeActive = activePath === 'executive-dashboard';
  const isAlertsActive = activePath === 'alerts-notifications';

  return (
    <header className="fixed top-0 left-0 right-0 h-14 z-50 bg-[var(--color-background-surface)]/98 backdrop-blur-md border-b border-[var(--color-border)] flex items-center justify-between px-4 sm:px-5 lg:px-6 select-none">
      {/* Left: Mobile Drawer Trigger + Brand */}
      <div className="flex items-center gap-1.5 sm:gap-2.5 min-w-0">
        {/* Mobile Menu Button */}
        <button
          onClick={onToggleSidebar}
          aria-label="Toggle navigation menu"
          className="lg:hidden flex items-center justify-center w-9 h-9 -ml-1 rounded-[var(--radius-element)] text-[var(--color-text-secondary)] hover:bg-[var(--color-background-subtle)] hover:text-[var(--color-text-primary)] transition-colors focus:outline-none cursor-pointer"
        >
          <span className="material-symbols-outlined text-[20px]">menu</span>
        </button>

        {/* Brand */}
        <div
          className="flex items-center cursor-pointer min-w-0"
          onClick={() => onNavigate('executive-dashboard')}
        >
          <NeovaticLogo size={34} />
        </div>
      </div>

      {/* Center: Command Palette Trigger */}
      <div className="flex-1 max-w-md mx-4 sm:mx-6 hidden md:block">
        <div
          onClick={onOpenCommandPalette}
          className="relative flex items-center w-full cursor-pointer group"
        >
          <span className="material-symbols-outlined absolute left-3 text-[var(--color-text-placeholder)] text-[17px] group-hover:text-[var(--color-text-secondary)] transition-colors">
            search
          </span>
          <input
            readOnly
            value=""
            placeholder="Quick jump…"
            className="w-full h-8 pl-9 pr-14 rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-placeholder)] font-body-sm border border-transparent focus:border-[var(--color-primary)] transition-colors cursor-pointer"
            type="text"
          />
          <div className="absolute right-2.5 flex items-center gap-1 pointer-events-none">
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-[var(--color-background-surface)] text-[var(--color-text-muted)] border border-[var(--color-border-strong)] rounded-[var(--radius-inner)] shadow-[var(--shadow-xs)]">⌘K</kbd>
          </div>
        </div>
      </div>

      {/* Right: Actions + Profile */}
      <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
        {/* Mobile search */}
        <button
          onClick={onOpenCommandPalette}
          aria-label="Search"
          className="md:hidden flex items-center justify-center w-8 h-8 rounded-[var(--radius-element)] hover:bg-[var(--color-background-subtle)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[18px]">search</span>
        </button>

        {/* Home */}
        <button
          type="button"
          onClick={() => onNavigate('executive-dashboard')}
          title="Home"
          aria-label="Home"
          className={`flex items-center justify-center w-8 h-8 rounded-[var(--radius-element)] transition-all cursor-pointer ${isHomeActive
              ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] shadow-[var(--shadow-xs)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-background-subtle)] hover:text-[var(--color-text-primary)]'
            }`}
        >
          <span className="material-symbols-outlined text-[20px]">home</span>
        </button>

        {/* Notifications */}
        <button
          type="button"
          onClick={() => onNavigate('alerts-notifications')}
          title="Alerts & Notifications"
          aria-label="Alerts & Notifications"
          className={`relative flex items-center justify-center w-8 h-8 rounded-[var(--radius-element)] transition-all cursor-pointer ${isAlertsActive
              ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] shadow-[var(--shadow-xs)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-background-subtle)] hover:text-[var(--color-text-primary)]'
            }`}
        >
          <span className="material-symbols-outlined text-[20px]">notifications</span>
          <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[var(--color-error)] ring-2 ring-[var(--color-background-surface)]"></span>
        </button>

        {/* Divider */}
        <div className="h-5 w-px bg-[var(--color-border)] mx-0.5 hidden sm:block" />

        {/* User Profile */}
        <div className="relative">
          <div
            onClick={() => setProfileOpen(!profileOpen)}
            className="flex items-center gap-2 cursor-pointer p-1 rounded-[var(--radius-element)] hover:bg-[var(--color-background-subtle)] transition-colors"
          >
            <div className="hidden 2xl:flex flex-col text-right">
              <span className="font-label-md text-[var(--color-text-primary)] font-medium leading-tight">
                {user?.name || 'Analytics User'}
              </span>
              <span className="font-label-sm text-[10px] text-[var(--color-text-muted)] leading-tight">
                {roleLabel}
              </span>
            </div>
            <div className="w-8 h-8 rounded-full bg-[var(--color-text-primary)] flex items-center justify-center text-white shrink-0 transition-colors">
              <span className="text-[13px] font-medium">
                {user?.name ? user.name.charAt(0).toUpperCase() : 'U'}
              </span>
            </div>
          </div>

          {/* Profile Dropdown */}
          {profileOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setProfileOpen(false)}
              />
              <div className="absolute right-0 mt-1.5 w-60 max-w-[calc(100vw-24px)] rounded-[var(--radius-container)] bg-[var(--color-background-surface)] border border-[var(--color-border)] shadow-[var(--shadow-lg)] p-1.5 z-50 text-left">
                <div className="px-3 py-2.5 border-b border-[var(--color-border)] mb-1">
                  <div className="font-label-lg text-[var(--color-text-primary)] font-semibold">{user?.name || 'Analytics User'}</div>
                  <div className="font-label-sm text-[var(--color-text-muted)] truncate mt-0.5" title={user?.email || 'user@sap.corp'}>
                    {user?.email || 'user@sap.corp'}
                  </div>
                  <div className="mt-1.5">
                    <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-[var(--radius-full)] ${
                      isAdmin ? 'bg-[var(--color-primary-soft)] text-[var(--color-primary)]' : 'bg-[var(--color-background-subtle)] text-[var(--color-text-secondary)]'
                    }`}>
                      {roleLabel}
                    </span>
                  </div>
                </div>

                <div className="space-y-0.5 font-body-sm text-[var(--color-text-secondary)]">
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => { setProfileOpen(false); onNavigate('user-management'); }}
                        className="w-full text-left px-3 py-2 rounded-[var(--radius-element)] hover:bg-[var(--color-background-subtle)] flex items-center justify-between transition-colors cursor-pointer"
                      >
                        <span>Users</span>
                        <span className="material-symbols-outlined text-[15px] text-[var(--color-text-muted)]">chevron_right</span>
                      </button>
                      <button
                        onClick={() => { setProfileOpen(false); onNavigate('system-settings'); }}
                        className="w-full text-left px-3 py-2 rounded-[var(--radius-element)] hover:bg-[var(--color-background-subtle)] flex items-center justify-between transition-colors cursor-pointer"
                      >
                        <span>System Management</span>
                        <span className="material-symbols-outlined text-[15px] text-[var(--color-text-muted)]">chevron_right</span>
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => { setProfileOpen(false); onNavigate('data-sources'); }}
                    className="w-full text-left px-3 py-2 rounded-[var(--radius-element)] hover:bg-[var(--color-background-subtle)] flex items-center justify-between transition-colors cursor-pointer"
                  >
                    <span>HDI Data Sources</span>
                    <span className="material-symbols-outlined text-[15px] text-[var(--color-text-muted)]">chevron_right</span>
                  </button>

                  {/* Logout */}
                  <div className="pt-1 mt-1 border-t border-[var(--color-border)]">
                    <button
                      onClick={() => {
                        setProfileOpen(false);
                        if (onLogout) {
                          onLogout();
                        } else {
                          onNavigate('enterprise-signin');
                        }
                      }}
                      className="w-full text-left px-3 py-2 rounded-[var(--radius-element)] hover:bg-[var(--color-error-soft)] text-[var(--color-error)] flex items-center justify-between transition-colors font-medium group cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[16px]">logout</span>
                        <span>Log Out</span>
                      </span>
                      <span className="text-[10px] text-[var(--color-text-muted)] font-mono">End Session</span>
                    </button>
                  </div>
                </div>

                <div className="pt-2 mt-1.5 border-t border-[var(--color-border)]">
                  <div className="flex items-center justify-between px-3 text-[10px] text-[var(--color-text-muted)] font-mono">
                    <span>HANA 4.2</span>
                    <span className="text-[var(--color-success)] font-semibold">ONLINE</span>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
};
