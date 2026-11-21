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

  // Helper for kind badge styling in Astryx
  const getKindBadge = (kind: string) => {
    switch (kind.toLowerCase()) {
      case 'kpi':
        return { label: 'KPI Card', bg: 'bg-[var(--color-success-soft)] text-[var(--color-success)] border-[var(--color-success-muted)]', icon: 'speed' };
      case 'line':
        return { label: 'Trend Line', bg: 'bg-[var(--color-primary-soft)] text-[var(--color-primary)] border-[var(--color-primary-muted)]', icon: 'show_chart' };
      case 'bar':
        return { label: 'Bar Chart', bg: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo)] border-[var(--color-indigo)]/20', icon: 'bar_chart' };
      case 'donut':
      case 'pie':
        return { label: 'Composition', bg: 'bg-[var(--color-ai-soft)] text-[var(--color-ai)] border-[var(--color-ai-muted)]', icon: 'pie_chart' };
      case 'horizontal_bar':
        return { label: 'Ranking', bg: 'bg-[var(--color-warning-soft)] text-[var(--color-warning)] border-[var(--color-warning-muted)]', icon: 'leaderboard' };
      default:
        return { label: kind.toUpperCase(), bg: 'bg-[var(--color-background-subtle)] text-[var(--color-text-secondary)] border-[var(--color-border)]', icon: 'analytics' };
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 overflow-y-auto animate-fade-in">
      <div className="bg-[var(--color-background-surface)] rounded-[var(--radius-container)] shadow-[var(--shadow-xl)] border border-[var(--color-border)] w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] bg-[var(--color-background-surface)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-[var(--radius-element)] bg-[var(--color-primary-soft)] text-[var(--color-primary)] flex items-center justify-center border border-[var(--color-primary-muted)]">
              <span className="material-symbols-outlined text-[20px]">smart_toy</span>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
                <span>Dataset Ingestion & AI Intelligence Report</span>
                <span className="px-2 py-0.5 rounded-[var(--radius-full)] text-[10px] font-medium bg-[var(--color-primary-soft)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]">
                  3-Agent Pipeline
                </span>
              </h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                Dataset: <span className="font-medium text-[var(--color-text-secondary)]">{datasetName}</span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-[var(--radius-element)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-subtle)] flex items-center justify-center transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-4">
          {/* Top Summary Cards: Agent 1 & Agent 2 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
            {/* Agent 1 Card */}
            <div className="p-4 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-primary)]">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-success)]">cleaning_services</span>
                  Agent 1: Preprocessing & Cleaning
                </span>
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-background-surface)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                  Zero Hardcode
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 pt-1">
                <div className="bg-[var(--color-background-surface)] p-2 rounded-[var(--radius-element)] border border-[var(--color-border)] text-center">
                  <div className="text-sm font-semibold text-[var(--color-text-primary)]">{audit?.rows_after ?? '—'}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">Clean Rows</div>
                </div>
                <div className="bg-[var(--color-background-surface)] p-2 rounded-[var(--radius-element)] border border-[var(--color-border)] text-center">
                  <div className="text-sm font-semibold text-[var(--color-success)]">{audit?.duplicates_removed ?? 0}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">Duplicates Dropped</div>
                </div>
                <div className="bg-[var(--color-background-surface)] p-2 rounded-[var(--radius-element)] border border-[var(--color-border)] text-center">
                  <div className="text-sm font-semibold text-[var(--color-primary)]">{audit?.null_values_cleaned ?? 0}</div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">Nulls Cleaned</div>
                </div>
              </div>
              <p className="text-[11px] text-[var(--color-text-secondary)]">
                {audit?.message || 'Sanitization complete. Duplicates removed and nulls safely remediated.'}
              </p>
            </div>

            {/* Agent 2 Card */}
            <div className="p-4 rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-primary)]">
                  <span className="material-symbols-outlined text-[16px] text-[var(--color-primary)]">psychology</span>
                  Agent 2: Domain Classification
                </span>
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-background-surface)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                  5-Row Sample AI
                </span>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs text-[var(--color-text-muted)]">Inferred Domain:</span>
                <span className="px-2.5 py-1 rounded-[var(--radius-element)] text-xs font-semibold bg-[var(--color-primary)] text-white uppercase tracking-wide">
                  {domain || 'Enterprise'}
                </span>
              </div>
              <p className="text-[11px] text-[var(--color-text-secondary)]">
                Inspected the first 5 rows to categorize measures, dimensions, dates, and autonomous natural language synonyms for Text-to-SQL.
              </p>
            </div>
          </div>

          {/* Agent 3 Section Header with Checkbox Controls */}
          <div className="pt-2">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-[var(--color-ai)]">auto_graph</span>
                <div>
                  <h3 className="text-xs font-semibold text-[var(--color-text-primary)]">
                    Agent 3: Suggested Charts & Executive KPIs
                  </h3>
                  <p className="text-[11px] text-[var(--color-text-muted)]">
                    Check the charts you wish to include on your Executive Dashboard.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--color-text-muted)] mr-1">
                  {selectedCount} of {recommendations.length} selected
                </span>
                <button
                  type="button"
                  onClick={selectAll}
                  className="px-2 py-1 text-xs font-medium rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-secondary)] border border-[var(--color-border)] transition-colors cursor-pointer"
                >
                  Select All
                </button>
                <button
                  type="button"
                  onClick={deselectAll}
                  className="px-2 py-1 text-xs font-medium rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-secondary)] border border-[var(--color-border)] transition-colors cursor-pointer"
                >
                  Deselect All
                </button>
              </div>
            </div>

            {/* Error banner if publishing fails */}
            {publishError && (
              <div className="mt-3 p-3 rounded-[var(--radius-element)] bg-[var(--color-error-soft)] border border-[var(--color-error-muted)] text-[var(--color-error)] text-xs font-medium flex items-center gap-2">
                <span className="material-symbols-outlined text-sm">error</span>
                <span>{publishError}</span>
              </div>
            )}

            {/* Recommended Charts Grid */}
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              {recommendations.map(item => {
                const isChecked = !!selectedIds[item.id];
                const badge = getKindBadge(item.kind);

                return (
                  <div
                    key={item.id}
                    onClick={() => toggleSelect(item.id)}
                    className={`relative p-3.5 rounded-[var(--radius-container)] border transition-all cursor-pointer flex flex-col justify-between ${
                      isChecked
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)]/40 shadow-[var(--shadow-xs)]'
                        : 'border-[var(--color-border)] bg-[var(--color-background-surface)] hover:border-[var(--color-border-strong)] opacity-80'
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
                            className="w-4 h-4 rounded text-[var(--color-primary)] focus:ring-[var(--color-primary)] border-[var(--color-border)] cursor-pointer"
                          />
                          <span className="text-xs font-semibold text-[var(--color-text-primary)] leading-snug">
                            {item.title}
                          </span>
                        </div>
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-full)] text-[10px] font-medium border shrink-0 ${badge.bg}`}
                        >
                          <span className="material-symbols-outlined text-[13px]">{badge.icon}</span>
                          {badge.label}
                        </span>
                      </div>

                      {/* Explanation */}
                      <p className="text-[11px] text-[var(--color-text-muted)] line-clamp-2 pl-6.5">
                        {item.explanation}
                      </p>
                    </div>

                    {/* Preview Value or Rows */}
                    <div className="mt-3 pt-2 border-t border-[var(--color-border)] flex items-center justify-between text-xs pl-6.5">
                      {item.preview_value ? (
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[10px] text-[var(--color-text-muted)]">Scorecard:</span>
                          <span className="text-xs font-semibold text-[var(--color-text-primary)] font-mono">
                            {item.preview_value}
                          </span>
                        </div>
                      ) : item.preview_rows && item.preview_rows.length > 0 ? (
                        <div className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)]"></span>
                          <span>{item.preview_rows.length} preview data points calculated</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-[var(--color-text-muted)]">Deterministic query verified</span>
                      )}

                      <span
                        className={`text-[10px] font-medium ${
                          isChecked ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]'
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
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-[var(--color-border)] bg-[var(--color-background-subtle)]">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-muted)] rounded-[var(--radius-element)] transition-colors cursor-pointer"
          >
            Skip for now
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              disabled={isPublishing || selectedCount === 0}
              onClick={handlePublish}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-[var(--radius-element)] bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50 transition-all shadow-[var(--shadow-xs)] cursor-pointer"
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
