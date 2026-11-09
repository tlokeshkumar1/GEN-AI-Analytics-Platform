/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { MobileBottomNav } from './components/MobileBottomNav';
import { CommandPalette } from './components/CommandPalette';
import type { UserContext } from './screens/EnterpriseSignIn';
import { clearLocalIdentity, sapRouterRoute, SIGNED_OUT_KEY } from './services/authNavigation';
import { selectedContext, ensureDefaultContext } from './services/executionContext';

const ExecutiveDashboard = lazy(() => import('./screens/ExecutiveDashboard').then(m => ({ default: m.ExecutiveDashboard })));
const GraphStudio = lazy(() => import('./screens/GraphStudio').then(m => ({ default: m.GraphStudio })));
const AIAgents = lazy(() => import('./screens/AIAgents').then(m => ({ default: m.AIAgents })));
const RAGChat = lazy(() => import('./screens/RAGChat').then(m => ({ default: m.RAGChat })));
const DatasetIngestion = lazy(() => import('./screens/DatasetIngestion').then(m => ({ default: m.DatasetIngestion })));
const DataExplorer = lazy(() => import('./screens/DataExplorer').then(m => ({ default: m.DataExplorer })));
const AlertsNotifications = lazy(() => import('./screens/AlertsNotifications').then(m => ({ default: m.AlertsNotifications })));
const ReportsLibrary = lazy(() => import('./screens/ReportsLibrary').then(m => ({ default: m.ReportsLibrary })));
const DataSources = lazy(() => import('./screens/DataSources').then(m => ({ default: m.DataSources })));
const UserManagement = lazy(() => import('./screens/UserManagement').then(m => ({ default: m.UserManagement })));
const SystemSettings = lazy(() => import('./screens/SystemSettings').then(m => ({ default: m.SystemSettings })));
const EnterpriseSignIn = lazy(() => import('./screens/EnterpriseSignIn').then(m => ({ default: m.EnterpriseSignIn })));
const HanaAdmin = lazy(() => import('./screens/HanaAdmin').then(m => ({ default: m.HanaAdmin })));

const ScreenFallback = () => (
  <div className="flex items-center justify-center min-h-[300px] p-12 text-slate-500">
    <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mr-3" />
    Loading view…
  </div>
);

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [currentUser, setCurrentUser] = useState<UserContext | null>(() => {
    try {
      const cached = localStorage.getItem('auth_user');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  });
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [activePath, setActivePath] = useState<string>(() => {
    try {
      const pathname = window.location.pathname.replace(/^\/+/, '').toLowerCase();
      if (pathname === 'hanaadmin' || pathname === 'hana-admin') return 'hanaadmin';
      const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
      if (hash === 'hanaadmin' || hash === 'hana-admin') return 'hanaadmin';
      const search = new URLSearchParams(window.location.search);
      const tab = search.get('tab') || search.get('page') || search.get('view');
      if (tab === 'hanaadmin' || tab === 'hana-admin') return 'hanaadmin';
    } catch {
      // ignore
    }
    return 'executive-dashboard';
  });
  const [hasOpenedChat, setHasOpenedChat] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [systemTab, setSystemTab] = useState('Connections');
  const [datasetScope, setDatasetScope] = useState(() => JSON.stringify(selectedContext()));

  useEffect(() => {
    void ensureDefaultContext();
  }, []);
  useEffect(() => {
    const handlePopState = () => {
      try {
        const pathname = window.location.pathname.replace(/^\/+/, '').toLowerCase();
        if (pathname === 'hanaadmin' || pathname === 'hana-admin') {
          setActivePath('hanaadmin');
        } else if (!pathname || pathname === 'executive-dashboard') {
          setActivePath('executive-dashboard');
        }
      } catch {
        // ignore
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);


  useEffect(() => {
    const onRoleChanged = () => {
      try {
        const cached = localStorage.getItem('auth_user');
        if (cached) setCurrentUser(JSON.parse(cached));
      } catch {
        // ignore
      }
    };
    window.addEventListener('auth-role-changed', onRoleChanged);
    return () => window.removeEventListener('auth-role-changed', onRoleChanged);
  }, []);

  useEffect(() => {
    const changed = () => setDatasetScope(JSON.stringify(selectedContext()));
    window.addEventListener('dataset-context-changed', changed);
    return () => window.removeEventListener('dataset-context-changed', changed);
  }, []);

  useEffect(() => {
    if (localStorage.getItem(SIGNED_OUT_KEY) === 'true') {
      setIsCheckingSession(false);
      return;
    }
    const token = localStorage.getItem('auth_token');

    // AppRouter forwards its SAP access token using the HttpOnly session cookie.
    // Check that session before considering a token from a local sign-in.
    let cancelled = false;
    let routerSession = true;
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((res) => {
        if ((res.status === 401 || res.status === 403) && token) {
          routerSession = false;
          return fetch('/api/auth/me', {
            credentials: 'same-origin',
            headers: { Authorization: `Bearer ${token}` }
          });
        }
        return res;
      })
      .then((res) => {
        if (res.ok) return res.json();
        throw new Error('Not authenticated');
      })
      .then((user: UserContext) => {
        if (cancelled) return;
        if (user && (user.user_id || user.email)) {
          if (routerSession) {
            localStorage.removeItem('auth_token');
            localStorage.removeItem('sap_ias_sso_token');
          }
          localStorage.setItem('auth_user', JSON.stringify(user));
          setCurrentUser(user);
          setIsAuthenticated(true);
        } else {
          throw new Error('Invalid user context');
        }
      })
      .catch(() => {
        if (cancelled) return;
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
        setIsAuthenticated(false);
        setCurrentUser(null);
      })
      .finally(() => {
        if (!cancelled) setIsCheckingSession(false);
      });
    return () => { cancelled = true; };
  }, []);

  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isChatMaximized, setIsChatMaximized] = useState(false);

  const [customGraphPrompt, setCustomGraphPrompt] = useState<string>(
    ''
  );

  const handleNavigate = (path: string) => {
    if (path === 'enterprise-signin' || path === 'logout') {
      handleLogout();
      return;
    }
    if (path === 'system-management' || path.startsWith('system-settings/')) {
      setSystemTab(path.endsWith('/connections') ? 'Connections' : 'Sync Jobs');
      path = 'system-settings';
    }
    if (path === 'ai-dashboards-rag-chat') {
      setHasOpenedChat(true);
      setIsChatOpen(true);
      setSidebarOpen(false);
      return;
    }
    if (path === 'upload-dataset') {
      const url = new URL(window.location.href);
      url.searchParams.delete('datasetId');
      window.history.replaceState({}, '', url.toString());
    }
    if (path === 'hanaadmin') {
      window.history.pushState({}, '', '/hanaadmin');
    } else if (path === 'executive-dashboard') {
      window.history.pushState({}, '', '/');
    }
    setActivePath(path);
    setSidebarOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleLogout = () => {
    void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => { });
    clearLocalIdentity(true);
    setIsAuthenticated(false);
    setCurrentUser(null);
    setHasOpenedChat(false);
    setIsChatOpen(false);
    setIsChatMaximized(false);
    setActivePath('enterprise-signin');
    setSidebarOpen(false);
    // Only redirect if an external AppRouter URL is explicitly configured
    const logoutTarget = sapRouterRoute('/logout');
    if (logoutTarget && logoutTarget.startsWith('http')) {
      window.location.replace(logoutTarget);
    }
  };

  useEffect(() => {
    const guardSignedOutSession = () => {
      if (localStorage.getItem(SIGNED_OUT_KEY) !== 'true') return;
      setIsAuthenticated(false);
      setCurrentUser(null);
      setHasOpenedChat(false);
      setIsCheckingSession(false);
    };
    const onSessionExpired = () => {
      setIsAuthenticated(false);
      setCurrentUser(null);
      setActivePath('enterprise-signin');
    };
    window.addEventListener('pageshow', guardSignedOutSession);
    window.addEventListener('storage', guardSignedOutSession);
    window.addEventListener('session-expired', onSessionExpired);
    return () => {
      window.removeEventListener('pageshow', guardSignedOutSession);
      window.removeEventListener('storage', guardSignedOutSession);
      window.removeEventListener('session-expired', onSessionExpired);
    };
  }, []);

  const handleSelectQueryFromPalette = (query: string) => {
    setCustomGraphPrompt(query);
  };

  const isAuthPage = !isAuthenticated || activePath === 'enterprise-signin' || activePath === 'enterprisesignin';

  if (isCheckingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-[#0F172A]" role="status" aria-live="polite">
        Signing in with SAP Universal ID / BTP IAS…
      </div>
    );
  }

  if (isAuthPage) {
    return (
      <Suspense fallback={<ScreenFallback />}>
        <EnterpriseSignIn
          onSignInSuccess={(user) => {
            setIsAuthenticated(true);
            if (user) {
              setCurrentUser(user);
            }
            handleNavigate('executive-dashboard');
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="min-h-screen min-h-dvh bg-[#F8FAFC] text-[#0F172A] font-body-md antialiased select-auto w-full overflow-x-hidden flex flex-col">
      {/* Global Responsive Header */}
      <Header
        activePath={activePath}
        onNavigate={handleNavigate}
        onToggleSidebar={() => setSidebarOpen(prev => !prev)}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onLogout={handleLogout}
        user={currentUser}
      />

      {/* Global Sidebar Navigation (Drawer on mobile/tablet/foldable, Fixed 260px on desktop) */}
      <Sidebar
        activePath={activePath}
        onNavigate={handleNavigate}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        user={currentUser}
        onLogout={handleLogout}
      />

      {/* Main Content Area - Fluidly & Automatically Determined for Every Screen & Aspect Ratio */}
      <div className="pl-0 lg:pl-[260px] w-full flex-1 transition-all duration-300">
        <main className="w-full pt-16 bg-[#F8FAFC] min-h-screen min-h-dvh pb-32 lg:pb-36">
          <Suspense fallback={<ScreenFallback />}>
            <div key={datasetScope} className="w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
              {activePath === 'executive-dashboard' && (
                <ExecutiveDashboard onNavigate={handleNavigate} />
              )}

              {activePath === 'build-your-kpi-graph-studio' && (
                <GraphStudio
                  onNavigate={handleNavigate}
                  user={currentUser}
                />
              )}

              {activePath === 'ai-agents' && (
                <AIAgents onNavigate={handleNavigate} />
              )}

              {activePath === 'upload-dataset' && (
                <DatasetIngestion onNavigate={handleNavigate} />
              )}

              {activePath === 'data-explorer' && (
                <DataExplorer onNavigate={handleNavigate} />
              )}

              {activePath === 'alerts-notifications' && (
                import.meta.env.VITE_DEMO_MODE === 'true' ? <AlertsNotifications onNavigate={handleNavigate} /> : <p className="p-6 bg-white rounded-xl text-slate-600">No alert rules are configured. Configure and validate source data before enabling alerts.</p>
              )}

              {activePath === 'reports-library' && (
                import.meta.env.VITE_DEMO_MODE === 'true' ? <ReportsLibrary onNavigate={handleNavigate} /> : <p className="p-6 bg-white rounded-xl text-slate-600">No saved reports are available. Review analytics in Graph Studio and publish approved dashboard widgets.</p>
              )}

              {activePath === 'data-sources' && (
                <DataSources onNavigate={handleNavigate} />
              )}

              {activePath === 'user-management' && (
                <UserManagement onNavigate={handleNavigate} />
              )}

              {activePath === 'system-settings' && (
                <SystemSettings key={systemTab} initialTab={systemTab} onNavigate={handleNavigate} />
              )}

              {activePath === 'hanaadmin' && (
                <HanaAdmin onNavigate={handleNavigate} />
              )}
            </div>
          </Suspense>
        </main>
      </div>

      {/* Floating RAG Chat Circular Trigger Button (Bottom Right) - Only visible when chat is closed */}
      {!isChatOpen && (
        <div className="fixed bottom-20 lg:bottom-6 right-4 sm:right-6 z-50 flex items-center gap-3 select-none animate-in fade-in duration-200">
          {/* Helper pill indicator visible when chat is closed */}
          <button
            type="button"
            onClick={() => {
              setHasOpenedChat(true);
              setIsChatOpen(true);
            }}
            className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/95 backdrop-blur-md border border-purple-200 text-[#0F172A] shadow-md hover:shadow-lg hover:border-purple-400 transition-all duration-200 text-xs font-medium cursor-pointer group animate-in fade-in slide-in-from-right-3"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-semibold bg-gradient-to-r from-purple-700 via-indigo-700 to-blue-700 bg-clip-text text-transparent">
              NEO Copilot
            </span>
            <span className="text-slate-400 font-mono text-[10px]">Ask HANA</span>
          </button>

          {/* Circular Action Button */}
          <button
            type="button"
            onClick={() => {
              setHasOpenedChat(true);
              setIsChatOpen(true);
            }}
            aria-label="Open NEO Copilot"
            title="Open NEO Copilot"
            className="relative w-12 h-12 sm:w-13 sm:h-13 rounded-full flex items-center justify-center text-white shadow-xl transition-all duration-300 cursor-pointer active:scale-95 group focus:outline-none focus:ring-4 focus:ring-purple-400/40 bg-gradient-to-tr from-purple-600 via-indigo-600 to-blue-600 hover:from-purple-500 hover:to-indigo-500 hover:scale-105 border-2 border-white/40 shadow-purple-500/25"
          >
            {/* Animated glow on hover */}
            <span className="absolute inset-0 rounded-full bg-gradient-to-tr from-purple-500 to-blue-500 opacity-0 group-hover:opacity-40 blur-md transition-opacity duration-300" />

            {/* Chat Symbol Icon */}
            <span className="material-symbols-outlined text-[22px] sm:text-[24px] relative z-10 transition-transform duration-200">
              chat
            </span>

            {/* Active Status Pulse Indicator */}
            <span className="absolute top-0 right-0 flex h-3.5 w-3.5 -mt-0.5 -mr-0.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500 border-2 border-white shadow-xs" />
            </span>
          </button>
        </div>
      )}

      {/* Floating Chat Modal / Drawer */}
      <div
        className={`fixed z-50 transition-all duration-300 ease-out bg-white rounded-2xl shadow-2xl border border-slate-200/90 overflow-hidden flex flex-col ${isChatOpen
            ? 'opacity-100 scale-100 pointer-events-auto translate-y-0'
            : 'opacity-0 scale-95 pointer-events-none translate-y-6'
          } ${isChatMaximized
            ? 'inset-2 sm:inset-6'
            : 'bottom-20 lg:bottom-6 right-2 sm:right-6 w-[calc(100vw-16px)] sm:w-[500px] xl:w-[560px] h-[calc(100vh-100px)] sm:h-[720px] max-h-[calc(100vh-100px)] lg:max-h-[calc(100vh-48px)]'
          }`}
      >
        {hasOpenedChat && (
          <Suspense fallback={<ScreenFallback />}>
            <RAGChat
              key={`${currentUser?.user_id}:${datasetScope}`}
              onNavigate={handleNavigate}
              isActive={isChatOpen}
              onClose={() => setIsChatOpen(false)}
              onToggleMaximize={() => setIsChatMaximized(prev => !prev)}
              isMaximized={isChatMaximized}
              user={currentUser}
            />
          </Suspense>
        )}
      </div>

      {/* Dimmed backdrop when maximized */}
      {isChatOpen && isChatMaximized && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-xs z-40 transition-opacity duration-300"
          onClick={() => setIsChatMaximized(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile / Tablet Bottom Ergonomic Navigation Bar (Hidden on desktop) */}
      <MobileBottomNav
        activePath={activePath}
        onNavigate={handleNavigate}
        onOpenDrawer={() => setSidebarOpen(true)}
      />

      {/* Global Quick Jump Command Palette (Cmd+K) */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNavigate={handleNavigate}
        onSelectQuery={handleSelectQueryFromPalette}
      />
    </div>
  );
}
