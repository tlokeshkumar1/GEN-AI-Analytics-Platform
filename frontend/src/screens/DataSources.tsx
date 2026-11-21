import React, { useEffect, useState } from 'react';
import { getDatasets } from '../services/datasetService';
import { DatasetItem } from '../types/dataset';
import { getApiErrorMessage } from '../services/api';

export const DataSources: React.FC<{ onNavigate: (path: string) => void }> = ({ onNavigate }) => {
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getDatasets().then(items => { if (!cancelled) { setDatasets(items); setLoading(false); } })
      .catch(err => { if (!cancelled) { setError(getApiErrorMessage(err, 'Data sources could not be loaded.')); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const totalRows = datasets.reduce((sum, d) => sum + (d.rowCount || 0), 0);
  const totalColumns = datasets.reduce((sum, d) => sum + (d.columnCount || 0), 0);
  const readyCount = datasets.filter(d => d.embeddingStatus === 'Ready').length;

  return (
    <div className="space-y-3.5 w-full max-w-[1560px] mx-auto pb-16">
      {/* Sleek, Single-Row Page Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-2 px-1 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[var(--color-text-primary)] flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">database</span>
          </div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-base font-semibold text-[var(--color-text-primary)] tracking-tight">Data Sources</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-full)] text-[11px] font-medium bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
              Data Catalog
            </span>
            <span className="text-xs text-[var(--color-text-muted)] font-mono hidden sm:inline">
              · {datasets.length} sources ({totalRows.toLocaleString()} total records)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] font-medium text-xs shadow-[var(--shadow-2xs)] transition-colors cursor-pointer"
            onClick={() => onNavigate('hanaadmin')}
          >
            <span className="material-symbols-outlined text-[15px] text-[var(--color-primary)]">database</span>
            <span>HANA Admin</span>
          </button>
          <button
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium text-xs shadow-[var(--shadow-2xs)] transition-colors cursor-pointer"
            onClick={() => onNavigate('system-settings/connections')}
          >
            <span className="material-symbols-outlined text-[15px]">cable</span>
            <span>Manage Connections</span>
          </button>
        </div>
      </div>

      {/* Summary Statistics */}
      {datasets.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {[
            { label: 'Total Datasets', value: datasets.length, icon: 'database' },
            { label: 'Total Records', value: totalRows.toLocaleString(), icon: 'table_rows' },
            { label: 'Schema Fields', value: totalColumns.toLocaleString(), icon: 'schema' },
            { label: 'Vector Index Ready', value: readyCount, icon: 'check_circle' },
          ].map(stat => (
            <div key={stat.label} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-3 shadow-[var(--shadow-2xs)]">
              <div className="flex items-center gap-2 mb-2">
                <span className="material-symbols-outlined text-[17px] text-[var(--color-text-secondary)]">{stat.icon}</span>
                <span className="text-[11px] font-medium text-[var(--color-text-secondary)]">{stat.label}</span>
              </div>
              <p className="text-base sm:text-lg font-semibold tracking-tight text-[var(--color-text-primary)] tabular-nums">{stat.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div role="alert" className="flex items-start gap-3 bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] rounded-[var(--radius-container)] p-4 shadow-[var(--shadow-2xs)]">
          <span className="material-symbols-outlined text-[var(--color-danger)] text-xl mt-0.5">error</span>
          <p className="text-xs font-medium text-[var(--color-danger)]">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && !error && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-page)] p-12 text-center shadow-[var(--shadow-xs)]">
          <div className="w-6 h-6 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-xs text-[var(--color-text-muted)]">Loading data sources…</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && !datasets.length && !error && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-page)] p-10 text-center space-y-4 shadow-[var(--shadow-xs)]">
          <div className="w-12 h-12 mx-auto rounded-[var(--radius-container)] bg-[var(--color-surface-active)] border border-[var(--color-border)] flex items-center justify-center">
            <span className="material-symbols-outlined text-[var(--color-text-muted)] text-2xl">cloud_upload</span>
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-primary)]">No imported datasets</p>
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Upload an Excel or CSV file to begin ingesting data.</p>
          </div>
          <button
            className="inline-flex items-center gap-2 bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-[var(--radius-element)] px-4 py-2 text-xs font-medium shadow-[var(--shadow-2xs)] transition-colors cursor-pointer"
            onClick={() => onNavigate('upload-dataset')}
          >
            <span className="material-symbols-outlined text-[16px]">upload_file</span>
            <span>Upload Excel or CSV</span>
          </button>
        </div>
      )}

      {/* Dataset Cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {datasets.map(item => (
          <section
            key={item.id}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-3.5 space-y-2.5 shadow-[var(--shadow-2xs)] hover:shadow-[var(--shadow-xs)] hover:border-[var(--color-border-strong)] transition-all"
          >
            {/* Card Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[var(--color-primary)] text-base">description</span>
                  <h2 className="text-xs sm:text-sm font-semibold text-[var(--color-text-primary)] truncate">{item.name}</h2>
                </div>
              </div>
              <span className={`shrink-0 text-[10px] uppercase font-semibold px-2 py-0.5 rounded-[var(--radius-full)] border ${
                item.embeddingStatus === 'Ready'
                  ? 'bg-[var(--color-success-subtle)] text-[var(--color-success)] border-[var(--color-success-border)]'
                  : item.embeddingStatus === 'Indexing' || item.embeddingStatus === 'Pending'
                  ? 'bg-[var(--color-warning-subtle)] text-[var(--color-warning)] border-[var(--color-warning-border)]'
                  : 'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] border-[var(--color-border)]'
              }`}>
                {item.embeddingStatus || 'Not indexed'}
              </span>
            </div>

            {/* Metadata */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] font-medium tabular-nums border border-[var(--color-border)]">
                <span className="material-symbols-outlined text-[13px]">table_rows</span>
                {item.rowCount?.toLocaleString() ?? '0'} rows
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] font-medium tabular-nums border border-[var(--color-border)]">
                <span className="material-symbols-outlined text-[13px]">view_column</span>
                {item.columnCount ?? '0'} fields
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] font-medium border border-[var(--color-border)]">
                <span className="material-symbols-outlined text-[13px]">layers</span>
                Version {item.currentVersion ?? 1}
              </span>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)]">
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Updated {new Date(item.lastUpdated).toLocaleString()}
              </p>
              <button
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-xs font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer"
                onClick={() => onNavigate('upload-dataset')}
              >
                <span className="material-symbols-outlined text-[14px] text-[var(--color-primary)]">open_in_new</span>
                <span>Open dataset</span>
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};
