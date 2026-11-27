import { RecommendationReview, type RecommendedChartItem } from './RecommendationReview';
export type { RecommendedChartItem } from './RecommendationReview';
import React from 'react';

export interface PreprocessingAudit {
  rows_before?: number;
  rows_after?: number;
  duplicates_removed?: number;
  null_values_cleaned?: number;
  message?: string;
  null_fixes_by_column?: Record<string, number>;
}

interface RecommendationModalProps {
  isOpen: boolean;
  onClose: () => void;
  datasetName: string;
  domain: string;
  audit?: PreprocessingAudit;
  recommendations: RecommendedChartItem[];
  onNavigateToDashboard: () => void;
  onNavigate?: (path: string) => void;
}

export const RecommendationModal: React.FC<RecommendationModalProps> = ({
  isOpen,
  onClose,
  datasetName,
  domain,
  audit,
  recommendations,
  onNavigateToDashboard,
  onNavigate,
}) => {
  if (!isOpen) return null;

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

          <section className="space-y-3 pt-2">
            <h3 className="text-sm font-semibold">Agent 3: Suggested Charts &amp; Executive KPIs</h3>
            <p className="text-xs text-[var(--color-text-muted)]">Review cards independently or select a group to approve or reject, then publish approved widgets.</p>
            <RecommendationReview recommendations={recommendations} navigate={onNavigate} />
          </section>
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

        </div>
      </div>
    </div>
  );
};
