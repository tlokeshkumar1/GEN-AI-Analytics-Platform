/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { MobileBottomNav } from './components/MobileBottomNav';
import { CommandPalette } from './components/CommandPalette';
import { AgentActivityModal } from './components/AgentActivityModal';
import type { UserContext } from './screens/EnterpriseSignIn';
import { clearLocalIdentity, getTokenExpiry, refreshAuthSession, sapRouterRoute, SIGNED_OUT_KEY } from './services/authNavigation';
import { selectedContext, ensureDefaultContext } from './services/executionContext';
import api from './services/api';
import { DataExplorerSkeleton } from './components/dashboard/DataExplorerSkeleton';

const loadExecutiveDashboard = () => import('./screens/ExecutiveDashboard').then(m => ({ default: m.ExecutiveDashboard }));
const loadGraphStudio = () => import('./screens/GraphStudio').then(m => ({ default: m.GraphStudio }));
const loadAIAgents = () => import('./screens/AIAgents').then(m => ({ default: m.AIAgents }));
const loadRAGChat = () => import('./screens/RAGChat').then(m => ({ default: m.RAGChat }));
const loadDatasetIngestion = () => import('./screens/DatasetIngestion').then(m => ({ default: m.DatasetIngestion }));
const loadDataExplorer = () => import('./screens/DataExplorer').then(m => ({ default: m.DataExplorer }));
const loadAlertsNotifications = () => import('./screens/AlertsNotifications').then(m => ({ default: m.AlertsNotifications }));
const loadReportsLibrary = () => import('./screens/ReportsLibrary').then(m => ({ default: m.ReportsLibrary }));
const loadDataSources = () => import('./screens/DataSources').then(m => ({ default: m.DataSources }));
const loadUserManagement = () => import('./screens/UserManagement').then(m => ({ default: m.UserManagement }));
const loadSystemSettings = () => import('./screens/SystemSettings').then(m => ({ default: m.SystemSettings }));
const loadEnterpriseSignIn = () => import('./screens/EnterpriseSignIn').then(m => ({ default: m.EnterpriseSignIn }));
const loadHanaAdmin = () => import('./screens/HanaAdmin').then(m => ({ default: m.HanaAdmin }));

const ExecutiveDashboard = lazy(loadExecutiveDashboard);
const GraphStudio = lazy(loadGraphStudio);
const AIAgents = lazy(loadAIAgents);
const RAGChat = lazy(loadRAGChat);
const DatasetIngestion = lazy(loadDatasetIngestion);
const DataExplorer = lazy(loadDataExplorer);
const AlertsNotifications = lazy(loadAlertsNotifications);
const ReportsLibrary = lazy(loadReportsLibrary);
const DataSources = lazy(loadDataSources);
const UserManagement = lazy(loadUserManagement);
const SystemSettings = lazy(loadSystemSettings);
const EnterpriseSignIn = lazy(loadEnterpriseSignIn);
const HanaAdmin = lazy(loadHanaAdmin);

const ScreenFallback = () => (
  <div className="flex items-center justify-center min-h-[300px] p-12 text-[var(--color-text-muted)]">
    <div className="w-5 h-5 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin mr-3" />
    Loading…
  </div>
);

const getCachedUser = (): UserContext | null => {
  try {
    if (localStorage.getItem(SIGNED_OUT_KEY) === 'true') return null;
    const cached = localStorage.getItem('auth_user');
    const parsed = cached ? JSON.parse(cached) : null;
    return parsed && (parsed.user_id || parsed.email) ? parsed : null;
  } catch {
    return null;
  }
};

const formatScopeKey = (ctx: ReturnType<typeof selectedContext>): string =>
  ctx ? `${ctx.datasetId}:${ctx.version}:${ctx.semanticRevision}` : '';

export default function App() {
  const [currentUser, setCurrentUser] = useState<UserContext | null>(getCachedUser);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => Boolean(getCachedUser()));
  const [isCheckingSession, setIsCheckingSession] = useState<boolean>(() => {
    if (localStorage.getItem(SIGNED_OUT_KEY) === 'true') return false;
    return !getCachedUser();
  });
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  });

  const handleToggleSidebarCollapse = () => {
    setIsSidebarCollapsed(prev => {
      const next = !prev;
      try {
        localStorage.setItem('sidebar_collapsed', String(next));
      } catch { }
      return next;
    });
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        handleToggleSidebarCollapse();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [systemTab, setSystemTab] = useState('Connections');
  const [datasetScope, setDatasetScope] = useState(() => formatScopeKey(selectedContext()));
  const lastScopeRef = useRef<string>(datasetScope);

  useEffect(() => {
    if (!isAuthenticated) return;
    void ensureDefaultContext();
    void loadExecutiveDashboard();
    const prefetch = () => {
      void loadGraphStudio();
      void loadDatasetIngestion();
      void loadDataSources();
      void loadDataExplorer();
      void loadRAGChat();
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(prefetch, { timeout: 2500 });
      return () => w.cancelIdleCallback?.(id);
    }
    const timer = window.setTimeout(prefetch, 1200);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated]);

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
    const changed = () => {
      const next = formatScopeKey(selectedContext());
      const prev = lastScopeRef.current;
      lastScopeRef.current = next;
      // Avoid remounting the initial screen when hydrating default context from empty
      if (!prev && next) return;
      if (prev !== next) setDatasetScope(next);
    };
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
      .then(async (res) => {
        if ((res.status === 401 || res.status === 403) && token) {
          routerSession = false;
          const tokenRes = await fetch('/api/auth/me', {
            credentials: 'same-origin',
            headers: { Authorization: `Bearer ${token}` }
          });
          if (tokenRes.status === 401) {
            const refreshed = await refreshAuthSession();
            if (refreshed?.token) {
              return fetch('/api/auth/me', {
                credentials: 'same-origin',
                headers: { Authorization: `Bearer ${refreshed.token}` }
              });
            }
          }
          return tokenRes;
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
            sessionStorage.removeItem('auth_token');
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
        clearLocalIdentity(false);
        setIsAuthenticated(false);
        setCurrentUser(null);
      })
      .finally(() => {
        if (!cancelled) setIsCheckingSession(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    let timerId: number | undefined;
    const scheduleRefresh = () => {
      if (timerId !== undefined) window.clearTimeout(timerId);
      const token = sessionStorage.getItem('auth_token') || localStorage.getItem('auth_token');
      if (!token || token.startsWith('dev-token-')) return;
      const expiresAt = getTokenExpiry();
      if (!expiresAt) return;
      // Refresh 60 seconds before token expiry so SSE and API requests never hit 401
      const delayMs = Math.max(5000, expiresAt - Date.now() - 60_000);
      timerId = window.setTimeout(() => {
        void refreshAuthSession().then((refreshed) => {
          if (refreshed?.token) {
            scheduleRefresh();
          }
        });
      }, delayMs);
    };

    scheduleRefresh();
    window.addEventListener('auth-token-refreshed', scheduleRefresh);
    return () => {
      if (timerId !== undefined) window.clearTimeout(timerId);
      window.removeEventListener('auth-token-refreshed', scheduleRefresh);
    };
  }, [isAuthenticated]);

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
    const token = localStorage.getItem('token') || sessionStorage.getItem('token');
    const userEmail = currentUser?.email;
    const userId = currentUser?.user_id;

    // End active project session on backend
    void api.post('/auth/logout', { user_id: userId, email: userEmail }).catch(() => {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ user_id: userId, email: userEmail }),
        credentials: 'same-origin',
      }).catch(() => { });
    });

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
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-background-body)] text-[var(--color-text-primary)]" role="status" aria-live="polite">
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
    <div className="min-h-screen min-h-dvh bg-[var(--color-background-body)] text-[var(--color-text-primary)] font-body-md antialiased select-auto w-full overflow-x-hidden flex flex-col">
      {/* Global Responsive Header */}
      <Header
        activePath={activePath}
        onNavigate={handleNavigate}
        onToggleSidebar={() => {
          if (typeof window !== 'undefined' && window.innerWidth < 768) {
            setSidebarOpen(prev => !prev);
          } else {
            handleToggleSidebarCollapse();
          }
        }}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onLogout={handleLogout}
        user={currentUser}
      />

      {/* Global Sidebar Navigation (Drawer on mobile, Compact on tablet, Expandable on desktop) */}
      <Sidebar
        activePath={activePath}
        onNavigate={handleNavigate}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={handleToggleSidebarCollapse}
        user={currentUser}
        onLogout={handleLogout}
      />

      {/* Main Content Area - dynamically adjusts to sidebar width without content overlap */}
      <div
        style={{ '--sidebar-width': isSidebarCollapsed ? '72px' : '256px' } as React.CSSProperties}
        className={`w-full flex-1 transition-all duration-200 ease-in-out ${isSidebarCollapsed ? 'pl-0 md:pl-[72px] lg:pl-[72px]' : 'pl-0 md:pl-[72px] lg:pl-[256px]'
          }`}
      >
        <main className="w-full pt-14 bg-[var(--color-background-body)] min-h-screen min-h-dvh pb-28 lg:pb-32">
          <Suspense fallback={<ScreenFallback />}>
            <div className="w-full max-w-[var(--content-max-width)] mx-auto px-4 sm:px-5 lg:px-8 py-5">
              {activePath === 'executive-dashboard' && (
                <ExecutiveDashboard onNavigate={handleNavigate} />
              )}

              {activePath === 'build-your-kpi-graph-studio' && (
                <GraphStudio
                  onNavigate={handleNavigate}
                  user={currentUser}
                  initialMode="prompt"
                />
              )}

              {activePath === 'widgets' && <GraphStudio onNavigate={handleNavigate} user={currentUser} widgetsOnly />}

              {activePath === 'ai-agents' && (
                <AIAgents onNavigate={handleNavigate} />
              )}

              {activePath === 'upload-dataset' && (
                <DatasetIngestion onNavigate={handleNavigate} />
              )}

              {activePath === 'data-explorer' && (
                <Suspense fallback={<DataExplorerSkeleton />}>
                  <DataExplorer onNavigate={handleNavigate} />
                </Suspense>
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

      {/* Floating RAG Chat Trigger Button — Astryx-refined */}
      {!isChatOpen && (
        <div className="fixed bottom-20 lg:bottom-5 right-4 sm:right-5 z-50 flex items-center gap-2.5 select-none">
          {/* Helper pill */}
          <button
            type="button"
            onClick={() => {
              setHasOpenedChat(true);
              setIsChatOpen(true);
            }}
            className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-background-surface)]/95 backdrop-blur-md border border-[var(--color-border)] text-[var(--color-text-primary)] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] hover:border-[var(--color-ai-muted)] transition-all duration-200 text-xs font-medium cursor-pointer group"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse" />
            <span className="font-semibold text-[var(--color-ai)]">
              NEO Copilot
            </span>
            <span className="text-[var(--color-text-muted)] font-mono text-[10px]">Ask HANA</span>
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
            className="relative w-11 h-11 sm:w-12 sm:h-12 rounded-full flex items-center justify-center text-white shadow-[var(--shadow-lg)] transition-all duration-200 cursor-pointer active:scale-95 group focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ai)] focus-visible:ring-offset-2 bg-[var(--color-ai)] hover:bg-[var(--color-ai-hover)]"
          >
            <span className="material-symbols-outlined text-[22px] relative z-10">
              chat
            </span>

            {/* Status dot */}
            <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-success)] opacity-75" />
              <span className="relative inline-flex rounded-full h-3 w-3 bg-[var(--color-success)] border-2 border-white" />
            </span>
          </button>
        </div>
      )}

      {/* Floating Chat Modal / Drawer */}
      <div
        className={`fixed z-50 transition-all duration-200 ease-out bg-[var(--color-background-surface)] rounded-[var(--radius-page)] shadow-[var(--shadow-xl)] border border-[var(--color-border)] overflow-hidden flex flex-col ${isChatOpen
          ? 'opacity-100 scale-100 pointer-events-auto translate-y-0'
          : 'opacity-0 scale-95 pointer-events-none translate-y-4'
          } ${isChatMaximized
            ? 'inset-2 sm:inset-6'
            : 'bottom-20 lg:bottom-5 right-2 sm:right-5 w-[calc(100vw-16px)] sm:w-[480px] xl:w-[520px] h-[calc(100vh-100px)] sm:h-[680px] max-h-[calc(100vh-100px)] lg:max-h-[calc(100vh-48px)]'
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

      {/* Global Autonomous 3-Agent Activity Cockpit */}
      <AgentActivityModal
        onNavigateToDashboard={() => handleNavigate('executive-dashboard')}
        onNavigateToBuildKpi={() => handleNavigate('build-your-kpi-graph-studio')}
      />
    </div>
  );
}
