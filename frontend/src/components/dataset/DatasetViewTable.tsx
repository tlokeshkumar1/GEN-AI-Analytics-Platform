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
import { agentActivityStore } from '../../services/agentActivityStore';

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
        return;
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
    <div className={`bg-[var(--color-background-surface)] rounded-[var(--radius-container)] border border-[var(--color-border)] shadow-[var(--shadow-xs)] overflow-hidden flex flex-col ${className}`}>
      {/* Live Dataset Version, Sync Status & Operations Ribbon */}
      <div className="px-4 sm:px-5 py-2.5 bg-[var(--color-background-subtle)] border-b border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[var(--color-text-primary)]">
              Version {dataset.currentVersion}
            </span>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span className="text-[var(--color-text-secondary)]">
              {dataset.name} ({totalRows.toLocaleString()} rows)
            </span>
          </div>

          <div className="h-3.5 w-px bg-[var(--color-border)] hidden md:block" />

          {/* Version Management Action Controls directly above the dataset */}
          <div className="flex flex-wrap items-center gap-1.5">
            <label htmlFor="table-dataset-version" className="font-medium text-[var(--color-text-secondary)] text-xs">
              Version:
            </label>
            <select
              id="table-dataset-version"
              value={selectedRestoreVersion}
              onChange={e => setSelectedRestoreVersion(e.target.value)}
              disabled={isBusy}
              className="h-7 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 text-xs text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-primary)] cursor-pointer"
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
              className="h-7 rounded-[var(--radius-element)] bg-[var(--color-text-primary)] hover:bg-black px-2.5 text-xs font-medium text-white disabled:opacity-40 transition-all cursor-pointer shadow-[var(--shadow-xs)]"
            >
              Restore
            </button>

            <button
              type="button"
              disabled={isBusy || !canEdit}
              onClick={() => onRefreshEmbeddings?.()}
              className="h-7 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] hover:bg-[var(--color-background-muted)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] disabled:opacity-40 transition-all cursor-pointer shadow-[var(--shadow-xs)]"
            >
              ⚡ Embeddings
            </button>

            {onOpenSemanticModel && (
              <button
                type="button"
                onClick={onOpenSemanticModel}
                className="h-7 rounded-[var(--radius-element)] border border-[var(--color-primary-muted)] bg-[var(--color-primary-soft)] hover:bg-[var(--color-primary-muted)] px-2.5 text-xs font-medium text-[var(--color-primary)] transition-all cursor-pointer shadow-[var(--shadow-xs)] flex items-center gap-1"
                title="Review and update semantic model"
              >
                <span className="material-symbols-outlined text-[13px]">account_tree</span>
                <span>Semantic Model</span>
              </button>
            )}

            <button
              type="button"
              onClick={async () => {
                try {
                  const act = await agentActivityStore.loadDatasetActivity(dataset.id, dataset.currentVersion);
                  agentActivityStore.openModal(act.id);
                } catch {
                  const actId = agentActivityStore.ensureDatasetActivity(dataset);
                  agentActivityStore.openModal(actId);
                }
              }}
              className="h-7 rounded-[var(--radius-element)] border border-[var(--color-ai-muted)] bg-[var(--color-ai-soft)] hover:bg-[var(--color-ai-muted)] px-2.5 text-xs font-medium text-[var(--color-ai)] transition-all cursor-pointer shadow-[var(--shadow-xs)] flex items-center gap-1"
              title="View autonomous 3-agent ingestion activity"
            >
              <span className="material-symbols-outlined text-[13px]">smart_toy</span>
              <span>Agent Activity</span>
            </button>
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
      <div className="p-3 sm:p-4 border-b border-[var(--color-border)] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[var(--color-background-surface)]">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-3.5 h-3.5 text-[var(--color-text-muted)] absolute left-3 top-2.5 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search within dataset…"
            className="w-full pl-9 pr-3.5 py-1.5 text-xs rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-placeholder)] focus:outline-none focus:border-[var(--color-primary)] transition-all"
            aria-label="Filter dataset records"
          />
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          {/* Page size dropdown */}
          <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
            <span className="hidden sm:inline">Rows:</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="h-8 px-2 rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-xs focus:outline-none focus:border-[var(--color-primary)] cursor-pointer"
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
            className="h-8 px-3 rounded-[var(--radius-element)] bg-[var(--color-background-surface)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-background-subtle)] transition-colors flex items-center gap-1.5 text-xs font-medium shadow-[var(--shadow-xs)] disabled:opacity-50 cursor-pointer"
            title="Export filtered records to CSV"
          >
            <Download className="w-3.5 h-3.5 text-[var(--color-primary)]" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Main Table Container */}
      <div className="overflow-x-auto flex-1 min-h-[340px]">
        {isLoading ? (
          <div className="py-24 flex flex-col items-center justify-center gap-2.5 text-[var(--color-text-muted)]">
            <RefreshCw className="w-5 h-5 animate-spin text-[var(--color-primary)]" />
            <span className="text-xs font-medium">Loading dataset records…</span>
          </div>
        ) : error ? (
          <div role="alert" className="p-6 text-xs text-[var(--color-error)] font-medium">{error}</div>
        ) : rows.length === 0 ? (
          <div className="py-24 text-center space-y-2 text-[var(--color-text-muted)]">
            <div className="w-10 h-10 rounded-full bg-[var(--color-background-subtle)] flex items-center justify-center mx-auto text-[var(--color-text-muted)]">
              <Layers className="w-5 h-5" />
            </div>
            <div className="text-xs font-medium text-[var(--color-text-primary)]">
              {searchQuery ? 'No records match search criteria' : 'Dataset is currently empty'}
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] max-w-sm mx-auto">
              {searchQuery
                ? 'Try clearing your search query to see all records.'
                : 'Click "Append" on the operations panel to import or insert records into this dataset.'}
            </p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--color-background-subtle)] text-[var(--color-text-secondary)] border-b border-[var(--color-border)] select-none">
                {displayColumns.map((col) => {
                  const isSorted = sortField === col.name;
                  return (
                    <th
                      key={col.name}
                      onClick={() => handleSort(col.name)}
                      className="py-2.5 px-3.5 font-medium uppercase tracking-wider text-[11px] hover:bg-[var(--color-background-muted)] transition-colors cursor-pointer group whitespace-nowrap"
                      title={`Sort by ${col.name}`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span>{col.name}</span>
                        <span className="text-[var(--color-text-muted)] group-hover:text-[var(--color-text-primary)]">
                          {isSorted ? (
                            sortDir === 'asc' ? (
                              <ArrowUp className="w-3.5 h-3.5 text-[var(--color-primary)]" />
                            ) : (
                              <ArrowDown className="w-3.5 h-3.5 text-[var(--color-primary)]" />
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
            <tbody className="divide-y divide-[var(--color-border)] text-[var(--color-text-primary)]">
              {rows.map((row) => (
                <tr key={(row.__rowId ?? row.id)} className="hover:bg-[var(--color-background-subtle)] transition-colors">
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
                        className={`py-2.5 px-3.5 whitespace-nowrap ${
                          col.type === 'number' || col.type === 'percentage'
                            ? 'font-mono text-right'
                            : col.name === 'OrderNumber'
                            ? 'font-mono font-medium text-[var(--color-primary)]'
                            : ''
                        }`}
                      >
                        {col.name === 'Region' ? (
                          <span className="px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-background-subtle)] text-[var(--color-text-secondary)] border border-[var(--color-border)] font-medium text-[11px]">
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
      <div className="p-3 sm:p-3.5 border-t border-[var(--color-border)] bg-[var(--color-background-subtle)] flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]">
        <div>
          Showing{' '}
          <strong className="text-[var(--color-text-primary)]">
            {totalRows > 0 ? (currentPage - 1) * pageSize + 1 : 0}
          </strong>{' '}
          to{' '}
          <strong className="text-[var(--color-text-primary)]">
            {Math.min(currentPage * pageSize, totalRows)}
          </strong>{' '}
          of <strong className="text-[var(--color-text-primary)]">{totalRows.toLocaleString()}</strong> records
        </div>

        {/* Pager buttons */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={currentPage <= 1 || isLoading}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            className="p-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] hover:bg-[var(--color-background-muted)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--color-text-primary)] transition-colors cursor-pointer"
            aria-label="Previous page"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          <span className="px-2 font-medium text-[var(--color-text-primary)] text-xs">
            Page {currentPage} of {totalPages}
          </span>

          <button
            type="button"
            disabled={currentPage >= totalPages || isLoading}
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            className="p-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] hover:bg-[var(--color-background-muted)] disabled:opacity-40 disabled:cursor-not-allowed text-[var(--color-text-primary)] transition-colors cursor-pointer"
            aria-label="Next page"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
