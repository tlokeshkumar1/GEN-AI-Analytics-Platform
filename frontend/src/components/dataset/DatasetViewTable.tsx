import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Download,
  RefreshCw,
  FileSpreadsheet,
  Layers,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { DatasetItem, DatasetRow } from '../../types/dataset';
import { getDatasetData } from '../../services/datasetService';
import { getApiErrorMessage } from '../../services/api';
import { DatasetStatusBadge } from './DatasetStatusBadge';

interface DatasetViewTableProps {
  dataset: DatasetItem;
  onRefresh?: () => void;
  className?: string;
  onRestoreVersion?: (version: number) => void;
  onRefreshEmbeddings?: () => void;
  onOpenSemanticModel?: () => void;
  canEdit?: boolean;
  isBusy?: boolean;
}

export const DatasetViewTable: React.FC<DatasetViewTableProps> = ({
  dataset,
  className = '',
  onRestoreVersion,
  onRefreshEmbeddings,
  onOpenSemanticModel,
  canEdit = true,
  isBusy = false,
}) => {
  const [selectedRestoreVersion, setSelectedRestoreVersion] = useState('');
  const [rows, setRows] = useState<DatasetRow[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortField, setSortField] = useState<string>(dataset.columns[0]?.name ?? '');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const fetchRows = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsLoading(true);
    setError(null);
    try {
      const data = await getDatasetData(
        dataset.id,
        currentPage,
        pageSize,
        sortField,
        sortDir,
        debouncedSearch,
        dataset.currentVersion,
        controller.signal
      );
      if (!controller.signal.aborted) {
        setRows(data.rows);
        setTotalRows(data.totalRows);
        setTotalPages(data.totalPages);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setRows([]);
        setTotalRows(0);
        setError(getApiErrorMessage(err, 'Failed to load dataset rows.'));
      }
    } finally {
      if (abortRef.current === controller) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => () => abortRef.current?.abort(), []);

  const prevFilterRef = useRef({ id: dataset.id, search: debouncedSearch, size: pageSize });

  useEffect(() => {
    const prev = prevFilterRef.current;
    const filterChanged = prev.id !== dataset.id || prev.search !== debouncedSearch || prev.size !== pageSize;
    if (filterChanged) {
      prevFilterRef.current = { id: dataset.id, search: debouncedSearch, size: pageSize };
      if (currentPage !== 1) {
        setCurrentPage(1);
        return; // The currentPage change to 1 will trigger fetchRows on the next tick
      }
    }
    void fetchRows();
  }, [dataset.id, dataset.currentVersion, currentPage, pageSize, sortField, sortDir, debouncedSearch]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const handleExportCSV = () => {
    if (rows.length === 0) return;
    const columns = dataset.columns.map((c) => c.name);
    const headers = columns.join(',');
    const csvRows = rows.map((r) =>
      columns.map((col) => {
        const val = r[col];
        if (typeof val === 'string' && val.includes(',')) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val ?? '';
      }).join(',')
    );

    const csvContent = [headers, ...csvRows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${dataset.name.replace(/\.[^/.]+$/, '')}_export.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const displayColumns = dataset.columns || [];

  return (
    <div className={`bg-white rounded-2xl border border-[#E2E8F0] shadow-xs overflow-hidden flex flex-col ${className}`}>
      {/* Live Dataset Version, Sync Status & Operations Ribbon */}
      <div className="px-4 sm:px-5 py-3 bg-slate-50 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-800">
              Viewing Version {dataset.currentVersion}
            </span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-600">
              {dataset.name} ({totalRows.toLocaleString()} rows)
            </span>
          </div>

          <div className="h-4 w-px bg-slate-300 hidden md:block" />

          {/* Version Management Action Controls directly above the dataset */}
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="table-dataset-version" className="font-semibold text-slate-700 text-xs">
              Version:
            </label>
            <select
              id="table-dataset-version"
              value={selectedRestoreVersion}
              onChange={e => setSelectedRestoreVersion(e.target.value)}
              disabled={isBusy}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            >
              <option value="">Choose version to restore</option>
              {dataset.versions?.map(v => (
                <option
                  key={v.version}
                  value={v.version}
                  disabled={v.version === dataset.currentVersion}
                >
                  V{v.version} · {v.rowCount.toLocaleString()} rows · {v.operation}
                  {v.version === dataset.currentVersion ? ' (current)' : ''}
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={!selectedRestoreVersion || isBusy || !canEdit}
              onClick={() => onRestoreVersion?.(Number(selectedRestoreVersion))}
              className="rounded-lg bg-slate-900 hover:bg-slate-800 px-3 py-1 text-xs font-semibold text-white disabled:opacity-40 transition-all cursor-pointer shadow-2xs"
            >
              Restore Version
            </button>

            <button
              type="button"
              disabled={isBusy || !canEdit}
              onClick={() => onRefreshEmbeddings?.()}
              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-40 transition-all cursor-pointer shadow-2xs"
            >
              ⚡ Refresh Embeddings
            </button>

            {onOpenSemanticModel && (
              <button
                type="button"
                onClick={onOpenSemanticModel}
                className="rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-700 transition-all cursor-pointer shadow-2xs flex items-center gap-1"
                title="Review and update semantic model"
              >
                <span className="material-symbols-outlined text-[14px]">account_tree</span>
                <span>Update Semantic Model</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <DatasetStatusBadge
            type="embedding"
            status={dataset.embeddingStatus}
            chunkCount={dataset.embeddingCount}
          />
          <DatasetStatusBadge
            type="hana"
            status={dataset.hanaSyncStatus}
          />
        </div>
      </div>

      {/* Table Action & Filter Toolbar */}
      <div className="p-4 sm:p-5 border-b border-[#E2E8F0] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[#F8FAFC]">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-[#64748B] absolute left-3 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search within dataset..."
            className="w-full pl-9 pr-4 py-2 text-xs rounded-xl bg-white border border-[#CBD5E1] text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:border-[#2563EB] focus:ring-2 focus:ring-[#2563EB]/20 transition-all"
            aria-label="Filter dataset records"
          />
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          {/* Page size dropdown */}
          <div className="flex items-center gap-1.5 text-xs text-[#64748B]">
            <span className="hidden sm:inline">Rows per page:</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-8 px-2 rounded-lg bg-white border border-[#CBD5E1] text-[#0F172A] text-xs focus:outline-none focus:border-[#2563EB]"
              aria-label="Rows per page"
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          </div>

          {/* Export CSV button */}
          <button
            type="button"
            onClick={handleExportCSV}
            disabled={rows.length === 0}
            className="h-8 px-3 rounded-lg bg-white border border-[#CBD5E1] text-[#475569] hover:text-[#0F172A] hover:bg-[#F1F5F9] transition-colors flex items-center gap-1.5 text-xs font-medium shadow-2xs disabled:opacity-50 cursor-pointer"
            title="Export filtered records to CSV"
          >
            <Download className="w-3.5 h-3.5 text-[#2563EB]" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Main Table Container */}
      <div className="overflow-x-auto flex-1 min-h-[360px]">
        {isLoading ? (
          <div className="py-24 flex flex-col items-center justify-center gap-3 text-slate-500">
            <RefreshCw className="w-6 h-6 animate-spin text-[#2563EB]" />
            <span className="text-xs font-medium">Loading dataset records...</span>
          </div>
        ) : error ? (
          <div role="alert" className="p-6 text-sm text-red-700">{error}</div>
        ) : rows.length === 0 ? (
          <div className="py-24 text-center space-y-2 text-slate-500">
            <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto text-slate-400">
              <Layers className="w-6 h-6" />
            </div>
            <div className="text-sm font-semibold text-slate-800">
              {searchQuery ? 'No records match search criteria' : 'Dataset is currently empty'}
            </div>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              {searchQuery
                ? 'Try clearing your search query to see all records.'
                : 'Click "Append" on the left panel to import or insert records into this dataset.'}
            </p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse font-body-sm text-xs">
            <thead>
              <tr className="bg-[#F8FAFC] text-[#475569] border-b border-[#E2E8F0] select-none">
                {displayColumns.map((col) => {
                  const isSorted = sortField === col.name;
                  return (
                    <th
                      key={col.name}
                      onClick={() => handleSort(col.name)}
                      className="py-3 px-4 font-semibold uppercase tracking-wider text-[11px] hover:bg-slate-100/70 transition-colors cursor-pointer group whitespace-nowrap"
                      title={`Sort by ${col.name}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span>{col.name}</span>
                        <span className="text-slate-400 group-hover:text-slate-700">
                          {isSorted ? (
                            sortDir === 'asc' ? (
                              <ArrowUp className="w-3.5 h-3.5 text-[#2563EB]" />
                            ) : (
                              <ArrowDown className="w-3.5 h-3.5 text-[#2563EB]" />
                            )
                          ) : (
                            <ArrowUpDown className="w-3 h-3 opacity-40 group-hover:opacity-100" />
                          )}
                        </span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] text-[#0F172A]">
              {rows.map((row) => (
                <tr key={(row.__rowId ?? row.id)} className="hover:bg-[#F8FAFC] transition-colors">
                  {displayColumns.map((col) => {
                    const rawVal = row[col.name];
                    let formattedVal = String(rawVal ?? '');

                    if (col.type === 'number' && typeof rawVal === 'number') {
                      formattedVal = col.name.includes('USD') || col.name.includes('Cost') || col.name.includes('Price')
                        ? `$${rawVal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : rawVal.toLocaleString();
                    } else if (col.type === 'percentage' && typeof rawVal === 'number') {
                      formattedVal = `${rawVal.toFixed(1)}%`;
                    }

                    return (
                      <td
                        key={col.name}
                        className={`py-3 px-4 whitespace-nowrap ${
                          col.type === 'number' || col.type === 'percentage'
                            ? 'font-mono text-right'
                            : col.name === 'OrderNumber'
                            ? 'font-mono font-medium text-[#2563EB]'
                            : ''
                        }`}
                      >
                        {col.name === 'Region' ? (
                          <span className="px-2 py-0.5 rounded-md bg-[#F1F5F9] text-[#334155] border border-[#E2E8F0] font-medium text-[11px]">
                            {formattedVal}
                          </span>
                        ) : (
                          formattedVal
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination Footer */}
      <div className="p-3.5 sm:p-4 border-t border-[#E2E8F0] bg-[#F8FAFC] flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[#64748B]">
        <div>
          Showing{' '}
          <strong className="text-[#0F172A]">
            {totalRows > 0 ? (currentPage - 1) * pageSize + 1 : 0}
          </strong>{' '}
          to{' '}
          <strong className="text-[#0F172A]">
            {Math.min(currentPage * pageSize, totalRows)}
          </strong>{' '}
          of <strong className="text-[#0F172A]">{totalRows.toLocaleString()}</strong> records
        </div>

        {/* Pager buttons */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={currentPage <= 1 || isLoading}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            className="p-1.5 rounded-lg border border-[#CBD5E1] bg-white hover:bg-[#F1F5F9] disabled:opacity-40 disabled:cursor-not-allowed text-[#0F172A] transition-colors"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <span className="px-2.5 font-medium text-[#0F172A] text-xs">
            Page {currentPage} of {totalPages}
          </span>

          <button
            type="button"
            disabled={currentPage >= totalPages || isLoading}
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            className="p-1.5 rounded-lg border border-[#CBD5E1] bg-white hover:bg-[#F1F5F9] disabled:opacity-40 disabled:cursor-not-allowed text-[#0F172A] transition-colors"
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
