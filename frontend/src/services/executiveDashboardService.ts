import api from './api';
import { ensureDefaultContext, selectedContext } from './executionContext';
import type { AnalyticsDefinition, ExecutionResult } from './semanticService';

export type ExecutiveDashboardData = {
  title: string;
  widgets: { definition: AnalyticsDefinition; result: ExecutionResult }[];
  status: string;
};

const cache = new Map<string, { data: ExecutiveDashboardData; time: number }>();
const pending = new Map<string, Promise<{ scope: string; data: ExecutiveDashboardData }>>();
let generation = 0;

export function executiveDashboardScope(): string {
  let user: Record<string, unknown> = {};
  try { user = JSON.parse(sessionStorage.getItem('auth_user') || localStorage.getItem('auth_user') || '{}'); } catch {}
  return JSON.stringify([user.tenant_id, user.workspace_id, user.user_id || user.email, selectedContext()]);
}

export function cachedExecutiveDashboard(): ExecutiveDashboardData | null {
  const entry = cache.get(executiveDashboardScope());
  return entry && Date.now() - entry.time < 120_000 ? entry.data : null;
}

export function invalidateExecutiveDashboard(): void {
  generation += 1;
  cache.clear();
  pending.clear();
}

export async function loadExecutiveDashboard(force = false): Promise<{ scope: string; data: ExecutiveDashboardData }> {
  if (!selectedContext()) await ensureDefaultContext();
  const scope = executiveDashboardScope();
  const existing = !force && cachedExecutiveDashboard();
  if (existing) return { scope, data: existing };
  const requestKey = JSON.stringify([scope, generation]);
  const active = pending.get(requestKey);
  if (active) return active;
  const startedGeneration = generation;
  const request = api.get<ExecutiveDashboardData>(force ? '/dashboard?refresh=true' : '/dashboard', { timeout: 90_000 })
    .then(({ data }) => {
      if (startedGeneration === generation && scope === executiveDashboardScope()) {
        cache.set(scope, { data, time: Date.now() });
        while (cache.size > 16) cache.delete(cache.keys().next().value!);
      }
      return { scope, data };
    })
    .finally(() => { if (pending.get(requestKey) === request) pending.delete(requestKey); });
  pending.set(requestKey, request);
  return request;
}

if (typeof window !== 'undefined') {
  window.addEventListener('neovatic_signed_out_event', invalidateExecutiveDashboard);
}
