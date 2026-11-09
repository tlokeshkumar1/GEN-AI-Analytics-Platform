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
      <div className="flex flex-wrap items-center justify-between gap-3 py-1.5 px-0.5 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[18px]">database</span>
          </div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold text-slate-900 tracking-tight">Data Sources</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
              Data Catalog
            </span>
            <span className="text-xs text-slate-400 font-mono hidden sm:inline">
              · {datasets.length} sources ({totalRows.toLocaleString()} total records)
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-semibold text-xs shadow-2xs transition-colors cursor-pointer"
            onClick={() => onNavigate('hanaadmin')}
          >
            <span className="material-symbols-outlined text-[15px] text-blue-600">database</span>
            <span>HANA Admin</span>
          </button>
          <button
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shadow-2xs transition-colors cursor-pointer"
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
            { label: 'Total Datasets', value: datasets.length, icon: 'database', color: 'blue' },
            { label: 'Total Records', value: totalRows.toLocaleString(), icon: 'table_rows', color: 'indigo' },
            { label: 'Schema Fields', value: totalColumns.toLocaleString(), icon: 'schema', color: 'purple' },
            { label: 'Vector Index Ready', value: readyCount, icon: 'check_circle', color: 'emerald' },
          ].map(stat => (
            <div key={stat.label} className="bg-white border border-slate-200 rounded-xl p-3 shadow-2xs">
              <div className="flex items-center gap-2 mb-2">
                <span className={`material-symbols-outlined text-[18px] text-${stat.color}-600`}>{stat.icon}</span>
                <span className="text-[11px] font-semibold tracking-wide text-slate-500">{stat.label}</span>
              </div>
              <p className="text-base font-bold tracking-tight text-slate-900 tabular-nums">{stat.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div role="alert" className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4">
          <span className="material-symbols-outlined text-red-600 text-xl mt-0.5">error</span>
          <p className="text-sm font-medium text-red-800">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && !error && (
        <div className="bg-white border border-slate-200/80 rounded-2xl p-12 text-center shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-slate-500">Loading data sources…</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && !datasets.length && !error && (
        <div className="bg-white border border-slate-200/80 rounded-2xl p-10 text-center space-y-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-50 border border-slate-200 flex items-center justify-center">
            <span className="material-symbols-outlined text-slate-400 text-3xl">cloud_upload</span>
          </div>
          <div>
            <p className="text-lg font-semibold text-slate-800">No imported datasets</p>
            <p className="text-sm text-slate-500 mt-1">Upload an Excel or CSV file to begin ingesting data.</p>
          </div>
          <button
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl px-5 py-2.5 text-sm font-medium shadow-sm transition-colors"
            onClick={() => onNavigate('upload-dataset')}
          >
            <span className="material-symbols-outlined text-[18px]">upload_file</span>
            <span>Upload Excel or CSV</span>
          </button>
        </div>
      )}

      {/* Dataset Cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {datasets.map(item => (
          <section
            key={item.id}
            className="bg-white border border-slate-200 rounded-xl p-3.5 space-y-2.5 shadow-2xs hover:shadow-xs hover:border-slate-300 transition-all"
          >
            {/* Card Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-blue-600 text-base">description</span>
                  <h2 className="text-xs sm:text-sm font-bold text-slate-900 truncate">{item.name}</h2>
                </div>
              </div>
              <span className={`shrink-0 text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full border ${
                item.embeddingStatus === 'Ready'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : item.embeddingStatus === 'Indexing' || item.embeddingStatus === 'Pending'
                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-slate-50 text-slate-600 border-slate-200'
              }`}>
                {item.embeddingStatus || 'Not indexed'}
              </span>
            </div>

            {/* Metadata */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-medium tabular-nums">
                <span className="material-symbols-outlined text-[13px]">table_rows</span>
                {item.rowCount?.toLocaleString() ?? '0'} rows
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 font-medium tabular-nums">
                <span className="material-symbols-outlined text-[13px]">view_column</span>
                {item.columnCount ?? '0'} fields
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 font-medium">
                <span className="material-symbols-outlined text-[13px]">layers</span>
                Version {item.currentVersion ?? 1}
              </span>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between pt-2 border-t border-slate-100">
              <p className="text-xs text-slate-500">
                Updated {new Date(item.lastUpdated).toLocaleString()}
              </p>
              <button
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 transition-colors"
                onClick={() => onNavigate('upload-dataset')}
              >
                <span className="material-symbols-outlined text-[14px] text-blue-600">open_in_new</span>
                Open dataset workflow
              </button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};
