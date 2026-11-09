import React, { useEffect, useState } from 'react';
import api, { getApiErrorMessage } from '../services/api';
import { ensureDefaultContext } from '../services/executionContext';
import { AnalyticsWidget, formatTableCell } from '../components/AnalyticsWidget';
import { AnalyticsDefinition, ExecutionResult } from '../services/semanticService';

export function ExecutiveDashboard({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [dashboard, setDashboard] = useState<{
    title: string;
    widgets: { definition: AnalyticsDefinition; result: ExecutionResult }[];
    status: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (forceRefresh = false) => {
    setLoading(true);
    setError('');
    try {
      await ensureDefaultContext();
      const endpoint = forceRefresh ? '/dashboard?refresh=true' : '/dashboard';
      setDashboard((await api.get(endpoint)).data);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Dashboard could not be loaded.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const widgets = dashboard?.widgets ?? [];
  const kpiWidgets = widgets.filter(w => w.definition.kind === 'kpi');
  const chartWidgets = widgets.filter(w => w.definition.kind !== 'kpi');
  const widgetCount = widgets.length;
  const approvedCount = widgets.filter(w => w.definition.status === 'approved').length;

  return (
    <div className="space-y-3.5 w-full max-w-[1560px] mx-auto pt-1 pb-16">
      {/* Sleek, Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-1.5 px-0.5 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">dashboard</span>
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">
              {dashboard?.title || 'Executive Analytics Dashboard'}
            </h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              Live Insights
            </span>
            {widgetCount > 0 && (
              <span className="text-xs text-slate-400 font-mono hidden sm:inline">
                · {widgetCount} widgets ({approvedCount} active)
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onNavigate('build-your-kpi-graph-studio')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-semibold border border-blue-200 transition-colors shadow-2xs cursor-pointer"
          >
            <span className="material-symbols-outlined text-[15px]">add_chart</span>
            <span>Configure KPIs</span>
          </button>
          <button
            disabled={loading}
            onClick={() => void load(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-slate-700 font-semibold text-xs border border-slate-200 hover:bg-slate-50 hover:border-slate-300 transition-all shadow-2xs disabled:opacity-50 cursor-pointer"
          >
            <span className={`material-symbols-outlined text-[15px] text-blue-600 ${loading ? 'animate-spin' : ''}`}>
              {loading ? 'sync' : 'refresh'}
            </span>
            <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div role="alert" className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 shadow-xs">
          <span className="material-symbols-outlined text-red-600 text-xl mt-0.5">error</span>
          <div className="flex-1">
            <p className="text-sm font-medium text-red-800">{error}</p>
          </div>
          <button onClick={() => setError('')} className="text-red-400 hover:text-red-600 transition-colors cursor-pointer">
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>
      )}

      {/* Empty State */}
      {dashboard && !dashboard.widgets.length && (
        <div className="bg-white border border-slate-200/80 rounded-2xl p-12 text-center space-y-4 shadow-xs">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
            <span className="material-symbols-outlined text-3xl">insights</span>
          </div>
          <div>
            <h3 className="text-lg font-bold text-slate-800">No dashboard widgets published</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              Publish approved KPIs and charts from Build Your KPI to view them here.
            </p>
          </div>
          <button
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-5 py-2.5 text-xs font-semibold shadow-xs transition-all cursor-pointer"
            onClick={() => onNavigate('build-your-kpi-graph-studio')}
          >
            <span className="material-symbols-outlined text-[18px]">add_chart</span>
            <span>Open Build Your KPI</span>
          </button>
        </div>
      )}

      {/* KPI Cards (Compact, focused cards without full-width stretching) */}
      {kpiWidgets.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5">
          {kpiWidgets.map(({ definition, result }) => (
            <div
              key={`${definition.id}:${definition.revision}`}
              className="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs hover:shadow-xs transition-all flex flex-col justify-between"
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 truncate">
                  {definition.title}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                  KPI
                </span>
              </div>
              <AnalyticsWidget
                definition={definition}
                result={result}
                showTable={false}
                isDashboard={true}
              />
            </div>
          ))}
        </div>
      )}

      {/* Chart Widgets Grid (Just the visual charts, no raw table dump) */}
      {chartWidgets.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
          {chartWidgets.map(({ definition, result }) => (
            <section
              key={`${definition.id}:${definition.revision}`}
              className="bg-white border border-slate-200 rounded-xl p-3.5 shadow-2xs hover:shadow-xs transition-all space-y-2.5"
            >
              {/* Clean Widget Header */}
              <div className="flex items-center justify-between gap-3 pb-2 border-b border-slate-100">
                <div className="flex items-center gap-2.5 min-w-0">
                  <h2 className="text-xs sm:text-sm font-bold text-slate-900 truncate">
                    {definition.title}
                  </h2>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">
                    {definition.kind.replace("_", " ")}
                  </span>
                </div>
                <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">
                  Live
                </span>
              </div>

              {/* Chart Visualization (table hidden on dashboard) */}
              <AnalyticsWidget
                definition={definition}
                result={result}
                showTable={definition.kind === 'table'}
                isDashboard={true}
              />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
