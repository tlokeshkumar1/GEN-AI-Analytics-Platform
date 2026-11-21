import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { fetchManagedUsers, ManagedUser } from '../services/userManagementService';
import { getApiErrorMessage } from '../services/api';

interface UserManagementProps {
  onNavigate: (path: string) => void;
}

interface CachedUsersData {
  users: ManagedUser[];
  fetched_at: string | null;
  project_role_collections: string[];
}

let cachedUsersPayload: CachedUsersData | null = null;

export const UserManagement: React.FC<UserManagementProps> = ({ onNavigate }) => {
  const [users, setUsers] = useState<ManagedUser[]>(cachedUsersPayload?.users || []);
  const [loading, setLoading] = useState(!cachedUsersPayload);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(cachedUsersPayload?.fetched_at || null);
  const [projectCollections, setProjectCollections] = useState<string[]>(cachedUsersPayload?.project_role_collections || []);
  const requestRef = useRef<AbortController | null>(null);

  const refreshUsers = useCallback(async (isManual = false) => {
    if (requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    if (isManual || !cachedUsersPayload) {
      setLoading(true);
    }
    try {
      const data = await fetchManagedUsers(controller.signal, isManual);
      if (!controller.signal.aborted) {
        cachedUsersPayload = {
          users: data.users,
          fetched_at: data.fetched_at,
          project_role_collections: data.project_role_collections || [],
        };
        setUsers(data.users);
        setUpdatedAt(data.fetched_at);
        setProjectCollections(data.project_role_collections || []);
        setError(null);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(getApiErrorMessage(err, 'Unable to load XSUAA users. Please verify SAP BTP permissions and try again.'));
        if (axios.isAxiosError(err) && [401, 403].includes(err.response?.status ?? 0)) {
          cachedUsersPayload = null;
          setUsers([]);
          setUpdatedAt(null);
        }
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUsers();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refreshUsers();
    }, 180_000);

    return () => {
      window.clearInterval(interval);
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [refreshUsers]);

  return (
    <div className="flex flex-col w-full max-w-[1560px] mx-auto space-y-3.5 pb-16">
      {/* Sleek, Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">group</span>
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-[var(--color-text-primary)] tracking-tight">User Management & RBAC Roles</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              SAP BTP XSUAA
            </span>
            <span className="text-xs text-[var(--color-text-muted)] font-mono hidden sm:inline">
              · {users.length} accounts ({users.filter(u => u.status === 'Active').length} active)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => void refreshUsers(true)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] font-medium text-xs border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-all shadow-[var(--shadow-2xs)] disabled:opacity-50 cursor-pointer"
          >
            <span className={`material-symbols-outlined text-[15px] text-[var(--color-text-secondary)] ${loading ? 'animate-spin' : ''}`}>
              {loading ? 'sync' : 'refresh'}
            </span>
            <span>{loading ? 'Refreshing...' : 'Refresh Users'}</span>
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-[var(--radius-container)] border border-[var(--color-warning-border)] bg-[var(--color-warning-subtle)] p-4 text-xs text-[var(--color-warning)] flex flex-col gap-2">
          <div className="flex items-start gap-2.5">
            <span className="material-symbols-outlined text-[var(--color-warning)] text-[20px] shrink-0 mt-0.5">admin_panel_settings</span>
            <div className="flex-1">
              <div className="font-semibold text-[var(--color-text-primary)]">SAP BTP Directory Access Notice</div>
              <div className="text-[var(--color-text-secondary)] text-xs mt-0.5 leading-relaxed">{error}</div>
              {error.toLowerCase().includes('user management') && (
                <div className="mt-2.5 p-3 rounded-[var(--radius-element)] bg-[var(--color-surface)] border border-[var(--color-border)] text-xs text-[var(--color-text-secondary)] space-y-1.5">
                  <div className="font-semibold text-[var(--color-text-primary)]">How to assign directory permissions in SAP BTP Cockpit:</div>
                  <ol className="list-decimal list-inside space-y-1 text-[var(--color-text-secondary)] pl-1">
                    <li>Go to <strong>SAP BTP Cockpit</strong> &rarr; Your Subaccount &rarr; <strong>Security &rarr; Users</strong>.</li>
                    <li>Select your user account (e.g. your corporate email).</li>
                    <li>Click <strong>Assign Role Collection</strong>.</li>
                    <li>Check <strong>GEN-AI Analytics Platform User Management (dev)</strong> and click <strong>Assign</strong>.</li>
                    <li>Sign out of this application and log in again with your SAP credentials to refresh your authorization scopes.</li>
                  </ol>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="bg-[var(--color-surface)] rounded-[var(--radius-container)] shadow-[var(--shadow-2xs)] border border-[var(--color-border)] overflow-hidden" aria-busy={loading}>
        <div className="px-4 py-2.5 border-b border-[var(--color-border)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--color-text-primary)]">GEN-AI Project Accounts</span>
            <span className="px-2 py-0.5 rounded-[var(--radius-full)] bg-[var(--color-surface-active)] text-xs font-mono text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              {updatedAt
                ? `${users.length} Accounts / ${users.filter(user => user.status === 'Active').length} Active`
                : loading ? 'Loading accounts...' : 'Accounts unavailable'}
            </span>
          </div>
          <span className="text-xs text-[var(--color-text-muted)]">SAP XSUAA · Refreshes every 30s{updatedAt && ` · Updated ${new Date(updatedAt).toLocaleTimeString()}`}</span>
        </div>

        <div className="overflow-x-auto scroll-touch">
          <table className="w-full text-left text-xs min-w-[580px]">
            <thead>
              <tr className="bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] text-[11px] font-semibold uppercase tracking-wider border-b border-[var(--color-border)]">
                <th className="py-2.5 px-4">User / Identity</th>
                <th className="py-2.5 px-4">Role Descriptor</th>
                <th className="py-2.5 px-4">Security Tier</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-6 text-right">Last Login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {users.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 px-6 text-center text-[var(--color-text-muted)]">
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined text-[18px] text-[var(--color-primary)] animate-spin">sync</span>
                        <span>Loading project XSUAA accounts from SAP BTP...</span>
                      </div>
                    ) : error ? (
                      'User directory data is unavailable. Please check SAP BTP role assignments above.'
                    ) : (
                      'No users are assigned to GEN-AI Analytics Platform Administrator (dev) or GEN-AI Analytics Platform Member (dev).'
                    )}
                  </td>
                </tr>
              )}
              {users.map(u => (
                <tr key={u.id} className="hover:bg-[var(--color-surface-hover)] transition-colors">
                  <td className="py-2.5 px-4">
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] flex items-center justify-center font-semibold text-xs border border-[var(--color-border)]">
                        {u.name.slice(0, 2).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-medium text-[var(--color-text-primary)]">{u.name}</div>
                        <div className="text-[11px] text-[var(--color-text-muted)]">{u.email || 'Email unavailable'}</div>
                        {u.origin && <div className="text-[11px] text-[var(--color-text-muted)]">{u.origin}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 px-4 text-[var(--color-text-primary)] font-medium">{u.role}</td>
                  <td className="py-2.5 px-4">
                    <span className="px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[11px] font-mono text-[var(--color-text-secondary)] border border-[var(--color-border)] font-medium">
                      {u.tier}
                    </span>
                  </td>
                  <td className="py-2.5 px-4">
                    <span className={`px-2 py-0.5 rounded-[var(--radius-full)] border text-[10px] font-medium ${u.status === 'Active' ? 'bg-[var(--color-success-subtle)] text-[var(--color-success)] border-[var(--color-success-border)]' : 'bg-[var(--color-surface-active)] text-[var(--color-text-muted)] border-[var(--color-border)]'}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="py-2.5 px-6 text-right font-mono text-[var(--color-text-muted)]">
                    {u.last_login ? (
                      new Date(u.last_login).toLocaleString()
                    ) : (
                      <span className="text-[var(--color-text-muted)] font-sans italic">Never</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">Only users directly assigned to {projectCollections.length ? projectCollections.join(' or ') : 'GEN-AI Analytics Platform Administrator (dev) or GEN-AI Analytics Platform Member (dev)'} are listed. Access through identity-provider group mappings may not appear as a direct assignment. Status shows whether the user is Active (has logged into this project) or Inactive (never signed in). Last Login reflects the latest sign-in recorded specifically for this project (GEN-AI Analytics Platform).</p>
    </div>
  );
};
