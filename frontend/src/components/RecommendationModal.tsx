import React, { useState } from 'react';
import api from '../services/api';

export interface PreprocessingAudit {
  rows_before?: number;
  rows_after?: number;
  duplicates_removed?: number;
  null_values_cleaned?: number;
  message?: string;
  null_fixes_by_column?: Record<string, number>;
}

export interface RecommendedChartItem {
  id: string;
  title: string;
  kind: string;
  query_plan: Record<string, any>;
  explanation: string;
  selected_by_default: boolean;
  preview_value?: string;
  preview_rows?: Array<Record<string, any>>;
}

interface RecommendationModalProps {
  isOpen: boolean;
  onClose: () => void;
  datasetName: string;
  domain: string;
  audit?: PreprocessingAudit;
  recommendations: RecommendedChartItem[];
  onNavigateToDashboard: () => void;
}

export const RecommendationModal: React.FC<RecommendationModalProps> = ({
  isOpen,
  onClose,
  datasetName,
  domain,
  audit,
  recommendations,
  onNavigateToDashboard,
}) => {
  if (!isOpen) return null;

  // Track selection state by item id
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    recommendations.forEach(r => {
      initial[r.id] = r.selected_by_default ?? true;
    });
    return initial;
  });

  const [isPublishing, setIsPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const selectAll = () => {
    const next: Record<string, boolean> = {};
    recommendations.forEach(r => {
      next[r.id] = true;
    });
    setSelectedIds(next);
  };

  const deselectAll = () => {
    const next: Record<string, boolean> = {};
    recommendations.forEach(r => {
      next[r.id] = false;
    });
    setSelectedIds(next);
  };

  const selectedCount = Object.values(selectedIds).filter(Boolean).length;

  const handlePublish = async () => {
    const approvedItems = recommendations.filter(r => selectedIds[r.id]);
    if (approvedItems.length === 0) {
      onClose();
      return;
    }

    setIsPublishing(true);
    setPublishError(null);
    try {
      await api.post('/dashboard/publish-recommended', {
        title: `${domain.charAt(0).toUpperCase() + domain.slice(1)} Analytics Dashboard`,
        items: approvedItems,
      });
      onClose();
      onNavigateToDashboard();
    } catch (err: any) {
      setPublishError(err?.response?.data?.detail || err?.message || 'Failed to publish to dashboard');
      setIsPublishing(false);
    }
  };

  // Helper for kind badge styling
  const getKindBadge = (kind: string) => {
    switch (kind.toLowerCase()) {
      case 'kpi':
        return { label: 'KPI Card', bg: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: 'speed' };
      case 'line':
        return { label: 'Trend Line', bg: 'bg-blue-50 text-blue-700 border-blue-200', icon: 'show_chart' };
      case 'bar':
        return { label: 'Bar Chart', bg: 'bg-indigo-50 text-indigo-700 border-indigo-200', icon: 'bar_chart' };
      case 'donut':
      case 'pie':
        return { label: 'Composition', bg: 'bg-purple-50 text-purple-700 border-purple-200', icon: 'pie_chart' };
      case 'horizontal_bar':
        return { label: 'Ranking', bg: 'bg-amber-50 text-amber-700 border-amber-200', icon: 'leaderboard' };
      default:
        return { label: kind.toUpperCase(), bg: 'bg-slate-50 text-slate-700 border-slate-200', icon: 'analytics' };
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4 overflow-y-auto animate-fade-in">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-slate-200 bg-linear-to-r from-blue-50/50 to-indigo-50/30">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center shadow-sm">
              <span className="material-symbols-outlined text-[22px]">smart_toy</span>
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <span>Dataset Ingestion & AI Intelligence Report</span>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-100 text-blue-800 border border-blue-200">
                  3-Agent Pipeline
                </span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Dataset: <span className="font-semibold text-slate-700">{datasetName}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 flex items-center justify-center transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Top Summary Cards: Agent 1 & Agent 2 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Agent 1 Card */}
            <div className="p-4 rounded-xl border border-emerald-200/80 bg-emerald-50/40 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800">
                  <span className="material-symbols-outlined text-[16px] text-emerald-600">cleaning_services</span>
                  Agent 1: Preprocessing & Cleaning
                </span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                  Zero Hardcode
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-1">
                <div className="bg-white/80 p-2 rounded-lg border border-emerald-100 text-center">
                  <div className="text-sm font-bold text-slate-800">{audit?.rows_after ?? '—'}</div>
                  <div className="text-[10px] text-slate-500">Clean Rows</div>
                </div>
                <div className="bg-white/80 p-2 rounded-lg border border-emerald-100 text-center">
                  <div className="text-sm font-bold text-emerald-600">{audit?.duplicates_removed ?? 0}</div>
                  <div className="text-[10px] text-slate-500">Duplicates Dropped</div>
                </div>
                <div className="bg-white/80 p-2 rounded-lg border border-emerald-100 text-center">
                  <div className="text-sm font-bold text-blue-600">{audit?.null_values_cleaned ?? 0}</div>
                  <div className="text-[10px] text-slate-500">Nulls Cleaned</div>
                </div>
              </div>
              <p className="text-[11px] text-emerald-900/80">
                {audit?.message || 'Sanitization complete. Duplicates removed and nulls safely remediated.'}
              </p>
            </div>

            {/* Agent 2 Card */}
            <div className="p-4 rounded-xl border border-blue-200/80 bg-blue-50/40 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-blue-800">
                  <span className="material-symbols-outlined text-[16px] text-blue-600">psychology</span>
                  Agent 2: Domain Classification
                </span>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                  5-Row Sample AI
                </span>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-slate-500">Inferred Domain:</span>
                <span className="px-2.5 py-1 rounded-md text-xs font-bold bg-blue-600 text-white shadow-2xs uppercase tracking-wide">
                  {domain || 'Enterprise'}
                </span>
              </div>
              <p className="text-[11px] text-blue-900/80">
                Inspected the first 5 rows to categorize measures, dimensions, dates, and autonomous natural language synonyms for Text-to-SQL.
              </p>
            </div>
          </div>

          {/* Agent 3 Section Header with Checkbox Controls */}
          <div className="pt-2">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-indigo-600">auto_graph</span>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">
                    Agent 3: Suggested Charts & Executive KPIs
                  </h3>
                  <p className="text-xs text-slate-500">
                    Check the charts you wish to include on your Executive Dashboard.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-500 mr-1">
                  {selectedCount} of {recommendations.length} selected
                </span>
                <button
                  type="button"
                  onClick={selectAll}
                  className="px-2.5 py-1 text-xs font-semibold rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer"
                >
                  Select All
                </button>
                <button
                  type="button"
                  onClick={deselectAll}
                  className="px-2.5 py-1 text-xs font-semibold rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer"
                >
                  Deselect All
                </button>
              </div>
            </div>

            {/* Error banner if publishing fails */}
            {publishError && (
              <div className="mt-3 p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs font-medium flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">error</span>
                <span>{publishError}</span>
              </div>
            )}

            {/* Recommended Charts Grid */}
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3.5">
              {recommendations.map(item => {
                const isChecked = !!selectedIds[item.id];
                const badge = getKindBadge(item.kind);

                return (
                  <div
                    key={item.id}
                    onClick={() => toggleSelect(item.id)}
                    className={`relative p-4 rounded-xl border transition-all cursor-pointer flex flex-col justify-between ${
                      isChecked
                        ? 'border-blue-500 bg-blue-50/20 shadow-xs ring-1 ring-blue-500/30'
                        : 'border-slate-200 bg-white hover:border-slate-300 opacity-75'
                    }`}
                  >
                    <div>
                      {/* Card Header with Checkbox and Badge */}
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2.5">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleSelect(item.id)}
                            onClick={e => e.stopPropagation()}
                            className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 border-slate-300 cursor-pointer"
                          />
                          <span className="text-xs font-bold text-slate-900 leading-snug">
                            {item.title}
                          </span>
                        </div>
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0 ${badge.bg}`}
                        >
                          <span className="material-symbols-outlined text-[13px]">{badge.icon}</span>
                          {badge.label}
                        </span>
                      </div>

                      {/* Explanation */}
                      <p className="text-[11px] text-slate-500 line-clamp-2 pl-6">
                        {item.explanation}
                      </p>
                    </div>

                    {/* Preview Value or Rows */}
                    <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between text-xs pl-6">
                      {item.preview_value ? (
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[10px] font-medium text-slate-400">Scorecard:</span>
                          <span className="text-sm font-bold text-slate-800 font-mono">
                            {item.preview_value}
                          </span>
                        </div>
                      ) : item.preview_rows && item.preview_rows.length > 0 ? (
                        <div className="text-[11px] text-slate-600 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span>
                          <span>{item.preview_rows.length} preview data points calculated</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-400">Deterministic query verified</span>
                      )}

                      <span
                        className={`text-[10px] font-semibold ${
                          isChecked ? 'text-blue-700' : 'text-slate-400'
                        }`}
                      >
                        {isChecked ? '✓ Include on Dashboard' : 'Omit'}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-200 bg-slate-50">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-800 hover:bg-slate-200/60 rounded-lg transition-colors cursor-pointer"
          >
            Skip for now
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={isPublishing || selectedCount === 0}
              onClick={handlePublish}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-all shadow-sm cursor-pointer"
            >
              <span className={`material-symbols-outlined text-[16px] ${isPublishing ? 'animate-spin' : ''}`}>
                {isPublishing ? 'sync' : 'dashboard_customize'}
              </span>
              <span>
                {isPublishing
                  ? 'Publishing…'
                  : `Confirm & Include ${selectedCount} on Dashboard`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

