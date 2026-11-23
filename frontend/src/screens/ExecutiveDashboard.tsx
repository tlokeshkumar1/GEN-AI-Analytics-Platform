import React, { useEffect, useState } from 'react';
import api, { getApiErrorMessage } from '../services/api';
import { ensureDefaultContext, selectedContext } from '../services/executionContext';
import { AnalyticsWidget, formatTableCell } from '../components/AnalyticsWidget';
import { AnalyticsDefinition, ExecutionResult } from '../services/semanticService';
import { getDatasets } from '../services/datasetService';

type DashboardData = {
  title: string;
  widgets: { definition: AnalyticsDefinition; result: ExecutionResult }[];
  status: string;
};

let cachedDashboardPayload: DashboardData | null = null;

export function invalidateDashboardCache() {
  cachedDashboardPayload = null;
}

interface SourceInfo {
  isJoined: boolean;
  count: number;
  label: string;
  datasets: string[];
}

function getChartTypeLabel(kind: string): string {
  switch (kind?.toLowerCase()) {
    case 'kpi':
      return 'KPI Metric';
    case 'bar':
      return 'Bar Chart';
    case 'horizontal_bar':
      return 'Horizontal Bar Chart';
    case 'line':
      return 'Line Chart';
    case 'area':
      return 'Area Chart';
    case 'pie':
      return 'Pie Chart';
    case 'donut':
      return 'Donut Chart';
    case 'scatter':
      return 'Scatter Plot';
    case 'gauge':
      return 'Gauge Chart';
    case 'funnel':
      return 'Funnel Chart';
    case 'radar':
      return 'Radar Chart';
    case 'table':
      return 'Data Table';
    default:
      return `${(kind || 'chart').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} Chart`;
  }
}

function getChartIcon(kind: string): string {
  switch (kind?.toLowerCase()) {
    case 'kpi':
      return 'speed';
    case 'bar':
      return 'bar_chart';
    case 'horizontal_bar':
      return 'align_horizontal_left';
    case 'line':
      return 'show_chart';
    case 'area':
      return 'area_chart';
    case 'pie':
      return 'pie_chart';
    case 'donut':
      return 'donut_large';
    case 'scatter':
      return 'bubble_chart';
    case 'gauge':
      return 'speed';
    case 'funnel':
      return 'filter_alt';
    case 'radar':
      return 'radar';
    case 'table':
      return 'table_chart';
    default:
      return 'analytics';
  }
}

function resolveSourceInfo(
  definition: AnalyticsDefinition,
  datasetMap: Record<string, string>,
  fallbackName?: string
): SourceInfo {
  const plan = ((definition.query_plan as any) || {}) as Record<string, any>;
  const joins = Array.isArray(plan.joins) ? plan.joins : [];

  // Determine primary / left dataset name
  const leftId = plan.left_dataset_id || plan.dataset_id || definition.dataset_id;
  const leftName =
    definition.dataset_name ||
    (leftId ? datasetMap[leftId] || leftId : '') ||
    (plan.dataset_name as string) ||
    fallbackName ||
    'Active Dataset';

  if (!joins.length) {
    return {
      isJoined: false,
      count: 1,
      label: leftName,
      datasets: [leftName],
    };
  }

  // Collect unique joined datasets
  const collected = new Set<string>();
  if (leftName) collected.add(leftName);

  for (const j of joins) {
    const rightId = j.right_dataset_id || j.dataset_id || j.right_table || j.table_name;
    const rightName =
      j.right_dataset_name ||
      (rightId ? datasetMap[rightId] || rightId : '') ||
      'Joined Dataset';
    if (rightName) collected.add(rightName);
  }

  const datasetList = Array.from(collected);
  const count = datasetList.length;

  return {
    isJoined: true,
    count,
    label: `${count} Joined Datasets (${datasetList.join(', ')})`,
    datasets: datasetList,
  };
}

export function ExecutiveDashboard({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(cachedDashboardPayload);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(!cachedDashboardPayload);
  const [datasetMap, setDatasetMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    getDatasets()
      .then(items => {
        if (!active) return;
        const map: Record<string, string> = {};
        for (const ds of items) {
          const name = ds.displayName || ds.name || ds.id;
          map[ds.id] = name;
          if (ds.name) map[ds.name] = name;
        }
        setDatasetMap(map);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const load = async (forceRefresh = false) => {
    const shouldBypass = forceRefresh || !cachedDashboardPayload;
    if (shouldBypass) {
      setLoading(true);
    }
    setError('');
    try {
      if (!selectedContext()) {
        await ensureDefaultContext();
      }
      const endpoint = shouldBypass ? '/dashboard?refresh=true' : '/dashboard';
      const data = (await api.get(endpoint)).data;
      cachedDashboardPayload = data;
      setDashboard(data);
    } catch (err) {
      cachedDashboardPayload = null;
      setDashboard(null);
      setError(getApiErrorMessage(err, 'Dashboard could not be loaded.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();

    const handleDashboardUpdated = () => {
      cachedDashboardPayload = null;
      void load(true);
    };
    window.addEventListener('dashboard_updated', handleDashboardUpdated);
    window.addEventListener('dataset-context-changed', handleDashboardUpdated);
    return () => {
      window.removeEventListener('dashboard_updated', handleDashboardUpdated);
      window.removeEventListener('dataset-context-changed', handleDashboardUpdated);
    };
  }, []);

  const widgets = !error ? (dashboard?.widgets ?? []) : [];
  const kpiWidgets = widgets.filter(w => w.definition.kind === 'kpi');
  const chartWidgets = widgets.filter(w => w.definition.kind !== 'kpi');
  const widgetCount = widgets.length;
  const approvedCount = widgets.filter(w => w.definition.status === 'approved').length;

  return (
    <div className="executive-dashboard space-y-3.5 w-full max-w-[1560px] mx-auto pt-1 pb-16">
      {/* Sleek, Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">dashboard</span>
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-[var(--color-text-primary)] tracking-tight">
              {dashboard?.title || 'Executive Analytics Dashboard'}
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium bg-[var(--color-success-subtle)] text-[var(--color-success)] border border-[var(--color-success-border)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
              Live Insights
            </span>
            {widgetCount > 0 && (
              <span className="text-xs text-[var(--color-text-muted)] font-mono hidden sm:inline">
                · {widgetCount} widgets ({approvedCount} active)
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onNavigate('build-your-kpi-graph-studio')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] text-xs font-medium border border-[var(--color-border)] transition-colors shadow-[var(--shadow-2xs)] cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">add_chart</span>
            <span>Configure KPIs</span>
          </button>
          <button
            disabled={loading}
            onClick={() => void load(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] text-xs font-medium border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-strong)] transition-all shadow-[var(--shadow-2xs)] disabled:opacity-50 cursor-pointer"
          >
            <span className={`material-symbols-outlined text-[15px] text-[var(--color-text-secondary)] ${loading ? 'animate-spin' : ''}`}>
              {loading ? 'sync' : 'refresh'}
            </span>
            <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div role="alert" className="flex items-start gap-3 bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] rounded-[var(--radius-container)] p-4 shadow-[var(--shadow-2xs)]">
          <span className="material-symbols-outlined text-[var(--color-danger)] text-xl mt-0.5">error</span>
          <div className="flex-1">
            <p className="text-xs font-medium text-[var(--color-danger)]">{error}</p>
          </div>
          <button onClick={() => setError('')} className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
      )}

      {/* Loading Skeletons */}
      {loading && !dashboard && !error && (
        <div className="space-y-3.5 animate-pulse" aria-busy="true" aria-label="Loading executive dashboard">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-3 h-24 space-y-2">
                <div className="h-3 bg-[var(--color-surface-active)] rounded w-2/3" />
                <div className="h-6 bg-[var(--color-surface-hover)] rounded w-1/2" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-4 h-72 space-y-3">
                <div className="h-4 bg-[var(--color-surface-active)] rounded w-1/3" />
                <div className="h-56 bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] w-full" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State */}
      {dashboard && !dashboard.widgets.length && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-page)] p-12 text-center space-y-4 shadow-[var(--shadow-xs)]">
          <div className="w-12 h-12 mx-auto rounded-[var(--radius-container)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center">
            <span className="material-symbols-outlined text-2xl">insights</span>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">No dashboard widgets published</h3>
            <p className="text-xs text-[var(--color-text-secondary)] mt-1 max-w-md mx-auto">
              Publish approved KPIs and charts from Build Your KPI to view them here.
            </p>
          </div>
          <button
            className="inline-flex items-center gap-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-[var(--radius-element)] px-4 py-2 text-xs font-medium shadow-[var(--shadow-2xs)] transition-all cursor-pointer"
            onClick={() => onNavigate('build-your-kpi-graph-studio')}
          >
            <span className="material-symbols-outlined text-[16px]">add_chart</span>
            <span>Open Build Your KPI</span>
          </button>
        </div>
      )}

      {/* KPI Cards (Compact, focused cards without full-width stretching) */}
      {kpiWidgets.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
          {kpiWidgets.map(({ definition, result }) => {
            const ctx = selectedContext();
            const fallbackName = (ctx?.datasetId ? datasetMap[ctx.datasetId] || ctx.datasetId : '') || 'Active Dataset';
            const sourceInfo = resolveSourceInfo(
              definition,
              datasetMap,
              fallbackName
            );
            const tooltipText = `Title: ${definition.title}\nType: ${getChartTypeLabel(definition.kind)}\nSource: ${sourceInfo.label}`;
            return (
              <div
                key={`${definition.id}:${definition.revision}`}
                title={tooltipText}
                className="group/card relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-3 shadow-[var(--shadow-2xs)] hover:border-[var(--color-border-strong)] transition-all flex flex-col justify-between"
              >
                <div className="mb-2">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] break-words leading-snug block">
                    {definition.title}
                  </span>
                </div>
                <AnalyticsWidget
                  definition={definition}
                  result={result}
                  showTable={false}
                  isDashboard={true}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Chart Widgets Grid (Just the visual charts, no raw table dump) */}
      {chartWidgets.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
          {chartWidgets.map(({ definition, result }) => {
            const ctx = selectedContext();
            const fallbackName = (ctx?.datasetId ? datasetMap[ctx.datasetId] || ctx.datasetId : '') || 'Active Dataset';
            const sourceInfo = resolveSourceInfo(
              definition,
              datasetMap,
              fallbackName
            );
            const tooltipText = `Title: ${definition.title}\nType: ${getChartTypeLabel(definition.kind)}\nSource: ${sourceInfo.label}`;
            return (
              <section
                key={`${definition.id}:${definition.revision}`}
                title={tooltipText}
                className="group/card relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-3.5 shadow-[var(--shadow-2xs)] hover:shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] transition-all space-y-2.5"
              >
                {/* Clean Widget Header */}
                <div className="flex flex-wrap items-center justify-between gap-2.5 pb-2 border-b border-[var(--color-border)]">
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <h2 className="text-xs sm:text-sm font-semibold text-[var(--color-text-primary)] break-words leading-snug">
                      {definition.title}
                    </h2>
                    <span className="text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)] shrink-0">
                      {definition.kind.replace("_", " ")}
                    </span>
                    {sourceInfo.label && (
                      <span
                        title={sourceInfo.label}
                        className="text-[10px] font-medium px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] truncate max-w-[220px]"
                      >
                        {sourceInfo.isJoined ? `${sourceInfo.count} Datasets` : sourceInfo.label}
                      </span>
                    )}
                  </div>
                </div>

                {/* Chart Visualization (table hidden on dashboard) */}
                <AnalyticsWidget
                  definition={definition}
                  result={result}
                  showTable={definition.kind === 'table'}
                  isDashboard={true}
                />
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
