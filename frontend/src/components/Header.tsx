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
    <header className="fixed top-0 left-0 right-0 h-16 z-50 bg-white/95 backdrop-blur-md border-b border-slate-200/80 flex items-center justify-between px-4 sm:px-6 lg:px-8 select-none">
      {/* Left: Mobile Drawer Trigger + Brand Lockup */}
      <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
        {/* Mobile / Tablet Menu Button */}
        <button
          onClick={onToggleSidebar}
          aria-label="Toggle navigation menu"
          className="lg:hidden flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 -ml-1 rounded-xl text-[#0F172A] hover:bg-[#F1F5F9] transition-colors focus:outline-none cursor-pointer"
        >
          <span className="material-symbols-outlined text-[22px] sm:text-[24px]">menu</span>
        </button>

        {/* Brand Lockup */}
        <div
          className="flex items-center cursor-pointer min-w-0"
          onClick={() => onNavigate('executive-dashboard')}
        >
          <NeovaticLogo size={38} />
        </div>
      </div>

      {/* Center: Global Quick Jump Input Bar */}
      <div className="flex-1 max-w-xl mx-4 sm:mx-6 hidden md:block">
        <div
          onClick={onOpenCommandPalette}
          className="relative flex items-center w-full cursor-pointer group"
        >
          <span className="material-symbols-outlined absolute left-3 text-[#64748B] text-[18px] group-hover:text-[#2563EB] transition-colors">
            search
          </span>
          <input
            readOnly
            value=""
            placeholder="Quick jump to pages or graphs..."
            className="w-full h-9 pl-9 pr-14 rounded-xl bg-[#F8FAFC] hover:bg-[#F1F5F9] text-[#0F172A] placeholder:text-[#64748B] font-body-sm text-body-sm border border-[#E2E8F0] focus:border-[#2563EB] transition-colors cursor-pointer"
            type="text"
          />
          <div className="absolute right-2.5 flex items-center gap-1 pointer-events-none">
            <kbd className="px-1.5 py-0.5 text-[10px] font-mono bg-white text-[#64748B] border border-[#CBD5E1] rounded shadow-2xs">⌘K</kbd>
          </div>
        </div>
      </div>

      {/* Right: Actions + User Profile */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* Search icon trigger on mobile */}
        <button
          onClick={onOpenCommandPalette}
          aria-label="Search and command palette"
          className="md:hidden flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl hover:bg-[#F1F5F9] text-[#64748B] hover:text-[#0F172A] transition-colors cursor-pointer"
        >
          <span className="material-symbols-outlined text-[19px]">search</span>
        </button>

        {/* Home Navigation Icon */}
        <button
          type="button"
          onClick={() => onNavigate('executive-dashboard')}
          title="Home"
          aria-label="Home"
          className={`flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl transition-all cursor-pointer ${isHomeActive
              ? 'bg-[#EFF6FF] text-[#2563EB] shadow-2xs border border-[#BFDBFE]/80 font-medium'
              : 'text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0F172A] border border-transparent'
            }`}
        >
          <span className="material-symbols-outlined text-[20px] sm:text-[22px]">home</span>
        </button>

        {/* Alerts & Notifications Navigation Icon */}
        <button
          type="button"
          onClick={() => onNavigate('alerts-notifications')}
          title="Alerts & Notifications"
          aria-label="Alerts & Notifications"
          className={`relative flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-xl transition-all cursor-pointer ${isAlertsActive
              ? 'bg-[#EFF6FF] text-[#2563EB] shadow-2xs border border-[#BFDBFE]/80 font-medium'
              : 'text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#0F172A] border border-transparent'
            }`}
        >
          <span className="material-symbols-outlined text-[20px] sm:text-[22px]">notifications</span>
          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-rose-500 ring-2 ring-white"></span>
        </button>

        {/* Subtle Vertical Divider */}
        <div className="h-6 w-[1px] bg-[#E2E8F0] mx-0.5 sm:mx-1 hidden sm:block" />

        {/* User Profile Lockup */}
        <div className="relative">
          <div
            onClick={() => setProfileOpen(!profileOpen)}
            className="flex items-center gap-2 cursor-pointer p-1 rounded-lg hover:bg-[#F1F5F9] transition-colors"
          >
            <div className="hidden 2xl:flex flex-col text-right">
              <span className="font-label-md text-label-md text-[#0F172A] font-semibold leading-tight">
                {user?.name || 'Analytics User'}
              </span>
              <span className="font-label-sm text-[10px] text-[#64748B] leading-tight font-medium">
                {roleLabel} ({roleSubtitle})
              </span>
            </div>
            <div className="w-8 h-8 rounded-full bg-[#0F172A] hover:bg-[#1E293B] flex items-center justify-center text-white shadow-sm shrink-0 transition-colors">
              <span className="material-symbols-outlined text-white text-[18px]">
                person
              </span>
            </div>
          </div>

          {/* Profile Dropdown Menu */}
          {profileOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setProfileOpen(false)}
              />
              <div className="absolute right-0 mt-2 w-64 max-w-[calc(100vw-24px)] rounded-xl bg-white border border-[#E2E8F0] shadow-xl p-3 z-50 text-left animate-in fade-in slide-in-from-top-2">
                <div className="px-2 py-1.5 border-b border-[#E2E8F0] mb-1.5">
                  <div className="font-label-md text-[#0F172A] font-semibold">{user?.name || 'Analytics User'}</div>
                  <div className="font-label-sm text-[#64748B] truncate" title={user?.email || 'user@sap.corp'}>
                    {user?.email || 'user@sap.corp'}
                  </div>
                  <div className="font-label-sm text-[10px] text-[#2563EB] mt-0.5 truncate font-medium flex items-center justify-between">
                    <span>Role: <strong>{roleLabel}</strong></span>
                    <span className="bg-[#EFF6FF] px-1.5 py-0.5 rounded text-[#1E40AF] font-mono">{roleLabel}</span>
                  </div>
                </div>

                <div className="space-y-0.5 text-body-sm text-[#334155]">
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => { setProfileOpen(false); onNavigate('user-management'); }}
                        className="w-full text-left px-2 py-2 rounded-lg hover:bg-[#F1F5F9] flex items-center justify-between transition-colors cursor-pointer"
                      >
                        <span>Users</span>
                        <span className="material-symbols-outlined text-[16px] text-[#64748B]">chevron_right</span>
                      </button>
                      <button
                        onClick={() => { setProfileOpen(false); onNavigate('system-settings'); }}
                        className="w-full text-left px-2 py-2 rounded-lg hover:bg-[#F1F5F9] flex items-center justify-between transition-colors cursor-pointer"
                      >
                        <span>System Management</span>
                        <span className="material-symbols-outlined text-[16px] text-[#64748B]">chevron_right</span>
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => { setProfileOpen(false); onNavigate('data-sources'); }}
                    className="w-full text-left px-2 py-2 rounded-lg hover:bg-[#F1F5F9] flex items-center justify-between transition-colors cursor-pointer"
                  >
                    <span>HDI Data Sources</span>
                    <span className="material-symbols-outlined text-[16px] text-[#64748B]">chevron_right</span>
                  </button>

                  {/* Dedicated Logout Option */}
                  <div className="pt-1 mt-1 border-t border-[#E2E8F0]">
                    <button
                      onClick={() => {
                        setProfileOpen(false);
                        if (onLogout) {
                          onLogout();
                        } else {
                          onNavigate('enterprise-signin');
                        }
                      }}
                      className="w-full text-left px-2 py-2 rounded-lg hover:bg-rose-50 text-rose-600 flex items-center justify-between transition-colors font-medium group cursor-pointer"
                    >
                      <span className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[17px] text-rose-600 group-hover:-translate-x-0.5 transition-transform">logout</span>
                        <span>Log Out</span>
                      </span>
                      <span className="text-[10px] text-rose-500 font-mono">End Session</span>
                    </button>
                  </div>
                </div>

                <div className="pt-2 mt-2 border-t border-[#E2E8F0]">
                  <div className="flex items-center justify-between px-2 text-[10px] text-[#64748B] font-mono">
                    <span>HANA 4.2</span>
                    <span className="text-[#16A34A] font-semibold">ONLINE</span>
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
