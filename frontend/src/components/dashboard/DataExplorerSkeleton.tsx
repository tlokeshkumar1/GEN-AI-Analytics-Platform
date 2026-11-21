import React from 'react';

export interface DataExplorerSkeletonProps {
  mode?: 'structured' | 'natural';
}

/**
 * Top card skeleton matching the query configuration panel in Data Explorer.
 */
export const DataExplorerTopSkeleton: React.FC<{ mode?: 'structured' | 'natural' }> = ({ mode = 'structured' }) => {
  return (
    <section
      data-testid="data-explorer-top-skeleton"
      aria-busy="true"
      aria-label="Loading query configuration"
      className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-5 space-y-4 shadow-[var(--shadow-2xs)] animate-pulse"
    >
      {mode === 'structured' ? (
        <>
          {/* Header indicator inside top card */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-[var(--color-surface-active)]" />
              <div className="h-3.5 w-36 bg-[var(--color-surface-active)] rounded" />
            </div>
            <div className="h-3.5 w-24 bg-[var(--color-surface-hover)] rounded" />
          </div>

          {/* 3-Column Input Grid (Metric, Aggregation, Group by) */}
          <div className="grid sm:grid-cols-3 gap-4 pt-1">
            <div className="space-y-1.5">
              <div className="h-3 w-14 bg-[var(--color-surface-active)] rounded" />
              <div className="h-[34px] w-full bg-[var(--color-surface-hover)] border border-[var(--color-border)] rounded-[var(--radius-element)]" />
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-20 bg-[var(--color-surface-active)] rounded" />
              <div className="h-[34px] w-full bg-[var(--color-surface-hover)] border border-[var(--color-border)] rounded-[var(--radius-element)]" />
            </div>
            <div className="space-y-1.5">
              <div className="h-3 w-16 bg-[var(--color-surface-active)] rounded" />
              <div className="h-[34px] w-full bg-[var(--color-surface-hover)] border border-[var(--color-border)] rounded-[var(--radius-element)]" />
            </div>
          </div>

          {/* Filter Bar Accordion Placeholder */}
          <div className="h-[36px] bg-[var(--color-surface-hover)] border border-[var(--color-border)] rounded-[var(--radius-element)] flex items-center px-3 gap-2">
            <div className="w-4 h-4 rounded bg-[var(--color-surface-active)]" />
            <div className="h-3 w-20 bg-[var(--color-surface-active)] rounded" />
          </div>

          {/* Execute Query Button Placeholder */}
          <div className="h-[34px] w-32 bg-[var(--color-surface-active)] rounded-[var(--radius-element)]" />
        </>
      ) : (
        <>
          {/* Natural Language Header */}
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-[var(--color-surface-active)]" />
            <div className="h-4 w-44 bg-[var(--color-surface-active)] rounded" />
          </div>

          {/* Suggestion Chips */}
          <div className="flex flex-wrap gap-2 pt-1">
            <div className="h-6 w-28 bg-[var(--color-surface-hover)] rounded-full border border-[var(--color-border)]" />
            <div className="h-6 w-36 bg-[var(--color-surface-hover)] rounded-full border border-[var(--color-border)]" />
            <div className="h-6 w-32 bg-[var(--color-surface-hover)] rounded-full border border-[var(--color-border)]" />
            <div className="h-6 w-40 bg-[var(--color-surface-hover)] rounded-full border border-[var(--color-border)]" />
          </div>

          {/* Prompt Textarea Placeholder */}
          <div className="h-24 w-full bg-[var(--color-surface-hover)] border border-[var(--color-border)] rounded-[var(--radius-element)]" />

          {/* Plan & Execute Button Placeholder */}
          <div className="h-[34px] w-36 bg-[var(--color-surface-active)] rounded-[var(--radius-element)]" />
        </>
      )}
    </section>
  );
};

/**
 * Bottom card skeleton matching the Analytical Output Canvas / Query Results table.
 */
export const DataExplorerResultsSkeleton: React.FC = () => {
  return (
    <section
      data-testid="data-explorer-bottom-skeleton"
      aria-busy="true"
      aria-label="Loading analytical output canvas"
      className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-5 space-y-4 shadow-[var(--shadow-2xs)] animate-pulse min-h-[300px]"
    >
      {/* Header bar: Icon + Title + Action Pill */}
      <div className="flex items-center justify-between pb-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-[var(--radius-element)] bg-[var(--color-surface-active)]" />
          <div className="h-4 w-40 bg-[var(--color-surface-active)] rounded" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-6 w-16 bg-[var(--color-surface-hover)] rounded-[var(--radius-inner)]" />
          <div className="h-6 w-24 bg-[var(--color-surface-hover)] rounded-[var(--radius-inner)]" />
        </div>
      </div>

      {/* Simulated Output Grid / Data Table Layout */}
      <div className="space-y-2 pt-1">
        {/* Table Header Row */}
        <div className="h-9 bg-[var(--color-surface-active)] rounded-[var(--radius-element)] w-full flex items-center px-4 gap-4">
          <div className="h-3 w-1/4 bg-[var(--color-surface-hover)] rounded" />
          <div className="h-3 w-1/4 bg-[var(--color-surface-hover)] rounded" />
          <div className="h-3 w-1/4 bg-[var(--color-surface-hover)] rounded" />
          <div className="h-3 w-1/4 bg-[var(--color-surface-hover)] rounded" />
        </div>

        {/* Alternating Data Rows */}
        <div className="h-8 bg-[var(--color-surface-hover)] rounded-[var(--radius-inner)] w-full flex items-center px-4 gap-4">
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)] rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)] rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)] rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)] rounded" />
        </div>
        <div className="h-8 bg-[var(--color-surface-hover)]/65 rounded-[var(--radius-inner)] w-full flex items-center px-4 gap-4">
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)]/80 rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)]/80 rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)]/80 rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)]/80 rounded" />
        </div>
        <div className="h-8 bg-[var(--color-surface-hover)] rounded-[var(--radius-inner)] w-full flex items-center px-4 gap-4">
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)] rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)] rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)] rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)] rounded" />
        </div>
        <div className="h-8 bg-[var(--color-surface-hover)]/65 rounded-[var(--radius-inner)] w-full flex items-center px-4 gap-4">
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)]/80 rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)]/80 rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)]/80 rounded" />
          <div className="h-2.5 w-1/4 bg-[var(--color-surface-active)]/80 rounded" />
        </div>
      </div>

      {/* Summary Stats / Pagination Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-[var(--color-border)]">
        <div className="h-3 w-36 bg-[var(--color-surface-active)] rounded" />
        <div className="h-3 w-28 bg-[var(--color-surface-active)] rounded" />
      </div>
    </section>
  );
};

/**
 * Full page skeleton matching the exact layout and design of Data Explorer.
 */
export const DataExplorerSkeleton: React.FC<DataExplorerSkeletonProps> = ({ mode = 'structured' }) => {
  return (
    <div
      data-testid="data-explorer-skeleton"
      className="space-y-3.5 w-full max-w-[1560px] mx-auto pb-16"
      aria-busy="true"
      aria-label="Loading Data Explorer"
    >
      {/* Sleek Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-[var(--color-border)] animate-pulse">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">explore</span>
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-[var(--color-text-primary)] tracking-tight">Data Explorer</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              Query Engine
            </span>
          </div>
        </div>

        {/* Mode Selector Placeholder */}
        <div className="flex items-center gap-1 p-1 bg-[var(--color-surface-hover)] rounded-[var(--radius-element)] border border-[var(--color-border)]">
          <div className="h-6 w-28 bg-[var(--color-surface)] rounded-[var(--radius-inner)] border border-[var(--color-border)]" />
          <div className="h-6 w-32 bg-[var(--color-surface-hover)] rounded-[var(--radius-inner)]" />
        </div>
      </div>

      {/* Top Card Skeleton */}
      <DataExplorerTopSkeleton mode={mode} />

      {/* Bottom Card Skeleton */}
      <DataExplorerResultsSkeleton />
    </div>
  );
};
