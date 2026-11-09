import React, { useEffect, useState, useMemo } from 'react';
import {
  HanaTable,
  HanaDatabaseStats,
  HanaColumn,
  TableDataResponse,
  QueryResultResponse,
  getHanaOverview,
  getHanaTableData,
  executeHanaQuery,
  deleteHanaTableRange,
} from '../services/hanaAdminService';
import { getApiErrorMessage } from '../services/api';

interface HanaAdminProps {
  onNavigate: (path: string) => void;
}

export const HanaAdmin: React.FC<HanaAdminProps> = ({ onNavigate }) => {
  // Navigation & View tabs
  const [activeTab, setActiveTab] = useState<'tables' | 'query' | 'schema'>('tables');

  // Database stats & table catalog
  const [stats, setStats] = useState<HanaDatabaseStats | null>(null);
  const [tables, setTables] = useState<HanaTable[]>([]);
  const [includeInternal, setIncludeInternal] = useState<boolean>(true);
  const [loadingTables, setLoadingTables] = useState<boolean>(true);
  const [tableSearch, setTableSearch] = useState<string>('');
  const [selectedTableName, setSelectedTableName] = useState<string>('');

  // Table Data Viewer state
  const [tableData, setTableData] = useState<TableDataResponse | null>(null);
  const [loadingData, setLoadingData] = useState<boolean>(false);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [sortField, setSortField] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [rowSearch, setRowSearch] = useState<string>('');
  const [searchDebounce, setSearchDebounce] = useState<string>('');

  // Cell inspector modal (for viewing full text of long cells)
  const [inspectCell, setInspectCell] = useState<{ column: string; value: string } | null>(null);
  const [copiedCell, setCopiedCell] = useState(false);

  // Column definitions view modal
  const [showColumnsModal, setShowColumnsModal] = useState<boolean>(false);

  // View Table & Record Details modal
  const [showViewModal, setShowViewModal] = useState<boolean>(false);

  // Delete Range Modal state ("delete: from where to where")
  const [showDeleteModal, setShowDeleteModal] = useState<boolean>(false);
  const [deleteMode, setDeleteMode] = useState<'row_range' | 'id_range' | 'condition'>('row_range');
  const [deleteFromRow, setDeleteFromRow] = useState<number>(1);
  const [deleteToRow, setDeleteToRow] = useState<number>(10);
  const [deleteFromId, setDeleteFromId] = useState<string>('');
  const [deleteToId, setDeleteToId] = useState<string>('');
  const [deleteCondition, setDeleteCondition] = useState<string>('');
  const [confirmDeleteCheck, setConfirmDeleteCheck] = useState<boolean>(false);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string>('');
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string>('');

  // SQL Console state
  const [sqlQuery, setSqlQuery] = useState<string>('SELECT * FROM "SALES_ANALYTICS" LIMIT 20');
  const [queryResult, setQueryResult] = useState<QueryResultResponse | null>(null);
  const [executingQuery, setExecutingQuery] = useState<boolean>(false);
  const [queryError, setQueryError] = useState<string>('');

  // Global error message
  const [error, setError] = useState<string>('');

  // Debounce search in table rows
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchDebounce(rowSearch);
      setCurrentPage(1);
    }, 350);
    return () => clearTimeout(timer);
  }, [rowSearch]);

  // Load database overview & tables
  const loadDatabaseOverview = async (showLoading = true) => {
    if (showLoading) setLoadingTables(true);
    setError('');
    try {
      const data = await getHanaOverview();
      setStats(data.stats);
      setTables(data.tables || []);
      if (!selectedTableName && data.tables?.length > 0) {
        const businessTable = data.tables.find(t => !t.isInternal);
        setSelectedTableName(businessTable ? businessTable.name : data.tables[0].name);
      }
    } catch (err: any) {
      setError(getApiErrorMessage(err, 'Failed to connect to SAP HANA Cloud.'));
    } finally {
      setLoadingTables(false);
    }
  };

  useEffect(() => {
    loadDatabaseOverview();
  }, []);

  // Fetch table data when selected table, page, pageSize, sort, or search changes
  const fetchActiveTableData = (tableName: string) => {
    if (!tableName || activeTab !== 'tables') return;

    setLoadingData(true);
    setError('');

    getHanaTableData(tableName, {
      page: currentPage,
      pageSize,
      sortField: sortField || undefined,
      sortDir,
      search: searchDebounce,
    })
      .then((data) => {
        setTableData(data);
      })
      .catch((err) => {
        setError(getApiErrorMessage(err, `Failed to fetch records for ${tableName}`));
      })
      .finally(() => {
        setLoadingData(false);
      });
  };

  useEffect(() => {
    fetchActiveTableData(selectedTableName);
  }, [selectedTableName, currentPage, pageSize, sortField, sortDir, searchDebounce, activeTab]);

  // Handle table selection
  const handleSelectTable = (name: string) => {
    if (name === selectedTableName) return;
    setSelectedTableName(name);
    setCurrentPage(1);
    setRowSearch('');
    setSearchDebounce('');
    setSortField('');
    setSortDir('asc');
    setTableData(null);
  };

  // Handle column header click for sorting
  const handleSort = (columnName: string) => {
    if (sortField === columnName) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(columnName);
      setSortDir('asc');
    }
    setCurrentPage(1);
  };

  // Filtered tables list for selector
  const filteredTables = useMemo(() => {
    return tables.filter(t => {
      if (!includeInternal && t.isInternal) return false;
      if (!tableSearch.trim()) return true;
      return t.name.toLowerCase().includes(tableSearch.toLowerCase().trim());
    });
  }, [tables, includeInternal, tableSearch]);

  const selectedTableObj = useMemo(() => {
    return tables.find(t => t.name.toUpperCase() === selectedTableName.toUpperCase());
  }, [tables, selectedTableName]);

  // Export current table view as CSV
  const handleExportCSV = () => {
    if (!tableData || !tableData.rows.length) return;
    const cols = tableData.columns.map(c => c.name);
    const headerRow = cols.join(',');
    const dataRows = tableData.rows.map(row => {
      return cols
        .map(c => {
          const val = row[c];
          if (val === null || val === undefined) return '';
          const str = String(val).replace(/"/g, '""');
          return `"${str}"`;
        })
        .join(',');
    });
    const csvContent = 'data:text/csv;charset=utf-8,' + [headerRow, ...dataRows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${selectedTableName}_page_${currentPage}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Execute Delete Range
  const handleExecuteDelete = async () => {
    if (!selectedTableName) return;
    if (!confirmDeleteCheck) {
      setDeleteError('Please check the confirmation box before deleting.');
      return;
    }
    setIsDeleting(true);
    setDeleteError('');
    try {
      const res = await deleteHanaTableRange(selectedTableName, {
        mode: deleteMode,
        fromRow: deleteMode === 'row_range' ? deleteFromRow : undefined,
        toRow: deleteMode === 'row_range' ? deleteToRow : undefined,
        fromId: deleteMode === 'id_range' ? deleteFromId : undefined,
        toId: deleteMode === 'id_range' ? deleteToId : undefined,
        condition: deleteMode === 'condition' ? deleteCondition : undefined,
      });

      setShowDeleteModal(false);
      setConfirmDeleteCheck(false);
      setActionSuccessMsg(`Successfully deleted ${res.deletedCount} rows from ${selectedTableName}. Remaining: ${res.remainingRows.toLocaleString()}`);
      setTimeout(() => setActionSuccessMsg(''), 6000);

      // Refresh overview and active table data
      await loadDatabaseOverview(false);
      fetchActiveTableData(selectedTableName);
    } catch (err: any) {
      setDeleteError(getApiErrorMessage(err, 'Failed to delete table records.'));
    } finally {
      setIsDeleting(false);
    }
  };

  // Run custom SQL query
  const handleExecuteSql = async () => {
    if (!sqlQuery.trim()) return;
    setExecutingQuery(true);
    setQueryError('');
    setQueryResult(null);
    try {
      const res = await executeHanaQuery(sqlQuery);
      setQueryResult(res);
    } catch (err: any) {
      setQueryError(getApiErrorMessage(err, 'Failed to execute query. Only read-only SELECT queries are allowed.'));
    } finally {
      setExecutingQuery(false);
    }
  };

  const handleCopyCell = () => {
    if (!inspectCell) return;
    navigator.clipboard.writeText(inspectCell.value);
    setCopiedCell(true);
    setTimeout(() => setCopiedCell(false), 2000);
  };

  return (
    <div className="space-y-2.5 w-full max-w-[1700px] mx-auto pb-16 animate-in fade-in duration-100">
      {/* 1. Ultra-Compact Unified Header (Merges Title, Stats, Tabs & Actions into One Clean Bar) */}
      <div className="bg-white border border-slate-200/90 rounded-xl px-3.5 py-2 flex flex-wrap items-center justify-between gap-2.5 shadow-2xs">
        {/* Left: Branding & Status */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-blue-600 text-[20px]">database</span>
            <span className="text-sm font-bold text-slate-900 tracking-tight whitespace-nowrap">
              HANA Cloud Explorer
            </span>
            <span className="px-1.5 py-0.2 rounded text-[9px] font-mono font-semibold bg-blue-50 text-blue-700 border border-blue-200">
              /hanaadmin
            </span>
          </div>

          <div className="h-3 w-px bg-slate-200 hidden sm:block" />

          {/* Quick status pill */}
          <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-slate-500">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="font-semibold text-emerald-700">Online</span>
            {stats && (
              <>
                <span className="text-slate-300">•</span>
                <span className="font-mono text-slate-700 truncate max-w-[140px]" title={stats.schema}>
                  {stats.schema}
                </span>
                <span className="text-slate-300">•</span>
                <span className="text-slate-700 font-semibold">{tables.length} Tables</span>
                <span className="text-slate-300">•</span>
                <span className="text-slate-700">{stats.totalRecords ? stats.totalRecords.toLocaleString() : '0'} rows</span>
              </>
            )}
          </div>
        </div>

        {/* Center: Tabs Switcher */}
        <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setActiveTab('tables')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-all cursor-pointer ${
              activeTab === 'tables'
                ? 'bg-white text-blue-600 shadow-2xs font-bold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className="material-symbols-outlined text-[15px]">table_chart</span>
            <span>Tables ({tables.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('query')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-all cursor-pointer ${
              activeTab === 'query'
                ? 'bg-white text-blue-600 shadow-2xs font-bold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className="material-symbols-outlined text-[15px]">terminal</span>
            <span>SQL Console</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('schema')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-all cursor-pointer ${
              activeTab === 'schema'
                ? 'bg-white text-blue-600 shadow-2xs font-bold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <span className="material-symbols-outlined text-[15px]">schema</span>
            <span>Catalog</span>
          </button>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => loadDatabaseOverview(true)}
            disabled={loadingTables}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-50"
            title="Scan SYS.TABLES for new tables"
          >
            <span className={`material-symbols-outlined text-[14px] text-blue-600 ${loadingTables ? 'animate-spin' : ''}`}>
              refresh
            </span>
            <span className="hidden sm:inline">Rescan</span>
          </button>

          <button
            type="button"
            onClick={() => onNavigate('upload-dataset')}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px]">upload_file</span>
            <span>Upload</span>
          </button>
        </div>
      </div>

      {/* Global Alerts / Success Messages */}
      {actionSuccessMsg && (
        <div role="status" className="flex items-center justify-between gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5 text-xs text-emerald-800 animate-in fade-in">
          <div className="flex items-center gap-1.5 font-medium">
            <span className="material-symbols-outlined text-emerald-600 text-base">check_circle</span>
            <span>{actionSuccessMsg}</span>
          </div>
          <button type="button" onClick={() => setActionSuccessMsg('')} className="text-emerald-700 hover:text-emerald-900 text-xs font-bold">
            ×
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 text-xs text-red-800">
          <div className="flex items-center gap-1.5 font-medium">
            <span className="material-symbols-outlined text-red-600 text-base">error</span>
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError('')} className="text-red-700 hover:text-red-900 text-xs font-bold">
            Dismiss
          </button>
        </div>
      )}

      {/* ==================== TAB 1: TABLES & DATA RECORDS ==================== */}
      {activeTab === 'tables' && (
        <div className="space-y-2.5 w-full">
          {/* 2. Sleek Compact Table Selector Bar (Reduced from giant panel to slim horizontal row) */}
          <div className="bg-white border border-slate-200/90 rounded-xl px-3 py-2 flex flex-wrap items-center justify-between gap-2 shadow-2xs">
            {/* Table Selection Pills */}
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mr-1">
                Tables:
              </span>
              {filteredTables.map((t) => {
                const isSelected = t.name.toUpperCase() === selectedTableName.toUpperCase();
                return (
                  <button
                    key={t.name}
                    type="button"
                    onClick={() => handleSelectTable(t.name)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer select-none border ${
                      isSelected
                        ? 'bg-blue-600 text-white border-blue-600 shadow-2xs font-semibold'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100 hover:border-slate-300'
                    }`}
                  >
                    <span className="material-symbols-outlined text-[14px]">
                      {t.name === 'VECTOR_TABLE' ? 'scatter_plot' : t.isInternal ? 'memory' : 'table_view'}
                    </span>
                    <span className="font-mono text-[11px] font-bold">{t.name}</span>
                    <span className={`text-[10px] px-1 py-0.2 rounded font-mono ${
                      isSelected ? 'bg-blue-700/80 text-white' : 'bg-slate-200 text-slate-700'
                    }`}>
                      {t.rowCount >= 1000 ? `${(t.rowCount / 1000).toFixed(1)}k` : t.rowCount}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Filter Input & Toggle */}
            <div className="flex items-center gap-2">
              <div className="relative w-36 sm:w-44">
                <span className="material-symbols-outlined absolute left-2 top-1 text-[13px] text-slate-400">
                  search
                </span>
                <input
                  type="text"
                  placeholder="Filter tables…"
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                  className="w-full pl-6 pr-5 py-0.5 text-[11px] bg-slate-50 border border-slate-200 rounded-md outline-none focus:border-blue-500 focus:bg-white"
                />
                {tableSearch && (
                  <button
                    type="button"
                    onClick={() => setTableSearch('')}
                    className="absolute right-1 top-0.5 text-slate-400 hover:text-slate-600"
                  >
                    <span className="material-symbols-outlined text-[12px]">close</span>
                  </button>
                )}
              </div>

              <label className="flex items-center gap-1 text-[11px] text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeInternal}
                  onChange={(e) => setIncludeInternal(e.target.checked)}
                  className="rounded text-blue-600 focus:ring-blue-500 h-3 w-3 cursor-pointer"
                />
                <span className="hidden sm:inline">Internal tables</span>
              </label>
            </div>
          </div>

          {/* 3. Full-Width Table Data Grid & Action Toolbar (Directly beneath table selector) */}
          <div className="w-full bg-white border border-slate-200/90 rounded-xl p-3 space-y-2.5 shadow-2xs">
            {/* Header Toolbar (Second Image Location) */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-100">
              {/* Left: Table Title & Rows */}
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-sm font-bold text-slate-900 truncate">
                  {selectedTableName || 'Select a table'}
                </span>
                {selectedTableObj && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold ${
                    selectedTableObj.isInternal ? 'bg-slate-100 text-slate-600' : 'bg-blue-50 text-blue-700'
                  }`}>
                    {selectedTableObj.type} TABLE
                  </span>
                )}
                <span className="text-xs text-slate-500">
                  (<strong className="text-slate-800">{tableData?.totalRows.toLocaleString() ?? '—'}</strong> total rows)
                </span>
              </div>

              {/* Right: Data Actions Toolbar (View, Fields, CSV, Delete Range) */}
              <div className="flex items-center gap-1.5">
                {/* 1. VIEW OPTION BUTTON */}
                <button
                  type="button"
                  onClick={() => setShowViewModal(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                  title="View table metadata & inspect sample records"
                >
                  <span className="material-symbols-outlined text-[14px] text-indigo-600">visibility</span>
                  <span>View</span>
                </button>

                {/* 2. FIELDS BUTTON */}
                <button
                  type="button"
                  onClick={() => setShowColumnsModal(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
                  title="View column definitions"
                >
                  <span className="material-symbols-outlined text-[14px] text-blue-600">view_column</span>
                  <span>Fields ({tableData?.columns?.length ?? selectedTableObj?.columnCount ?? 0})</span>
                </button>

                {/* 3. CSV EXPORT BUTTON */}
                <button
                  type="button"
                  onClick={handleExportCSV}
                  disabled={!tableData?.rows?.length}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer disabled:opacity-40"
                  title="Export page as CSV"
                >
                  <span className="material-symbols-outlined text-[14px] text-emerald-600">download</span>
                  <span>CSV</span>
                </button>

                {/* 4. DELETE RANGE BUTTON ("delete: from where to where") */}
                <button
                  type="button"
                  onClick={() => {
                    setShowDeleteModal(true);
                    setDeleteError('');
                    setConfirmDeleteCheck(false);
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-rose-200 bg-rose-50/70 hover:bg-rose-100 text-xs font-semibold text-rose-700 transition-colors cursor-pointer"
                  title="Delete records: specify range from where to where"
                >
                  <span className="material-symbols-outlined text-[14px] text-rose-600">delete_sweep</span>
                  <span>Delete: Range</span>
                </button>
              </div>
            </div>

            {/* Sub-toolbar: Search within table rows & Page size selector */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <span className="material-symbols-outlined absolute left-2 top-1.5 text-[15px] text-slate-400">
                  search
                </span>
                <input
                  type="text"
                  placeholder={`Search ${selectedTableName} rows…`}
                  value={rowSearch}
                  onChange={(e) => setRowSearch(e.target.value)}
                  className="w-full pl-7 pr-7 py-1 text-xs bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-blue-500 focus:bg-white transition-all"
                />
                {rowSearch && (
                  <button
                    type="button"
                    onClick={() => setRowSearch('')}
                    className="absolute right-2 top-1 text-slate-400 hover:text-slate-600 cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                )}
              </div>

              <div className="flex items-center gap-1.5 text-xs text-slate-500">
                <span>Per page:</span>
                <select
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    setCurrentPage(1);
                  }}
                  className="bg-white border border-slate-200 rounded-md px-2 py-0.5 text-xs text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>

            {/* Live Data Grid */}
            <div className="relative border border-slate-200 rounded-lg overflow-hidden bg-white shadow-2xs">
              {loadingData && (
                <div className="absolute inset-0 bg-white/70 backdrop-blur-2xs z-20 flex items-center justify-center">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white shadow-md border border-slate-200 text-xs font-semibold text-slate-700">
                    <div className="w-3.5 h-3.5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <span>Loading rows…</span>
                  </div>
                </div>
              )}

              <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="bg-slate-100/90 sticky top-0 z-10 border-b border-slate-200">
                    <tr>
                      <th className="py-1.5 px-2.5 font-semibold text-slate-500 w-10 text-center border-r border-slate-200 select-none">
                        #
                      </th>
                      {tableData?.columns?.map((col) => {
                        const isSorted = sortField === col.name;
                        return (
                          <th
                            key={col.name}
                            onClick={() => handleSort(col.name)}
                            className="py-1 px-2.5 font-semibold text-slate-700 whitespace-nowrap cursor-pointer hover:bg-slate-200/60 transition-colors border-r border-slate-200 select-none group"
                            title={`Sort by ${col.name} (${col.type})`}
                          >
                            <div className="flex items-center gap-1.5 justify-between">
                              <span className="font-mono text-[11px] font-bold">{col.name}</span>
                              <span className="material-symbols-outlined text-[13px] text-slate-400 group-hover:text-blue-600">
                                {isSorted ? (sortDir === 'asc' ? 'arrow_upward' : 'arrow_downward') : 'unfold_more'}
                              </span>
                            </div>
                            <span className="text-[9px] text-slate-400 font-normal font-sans block">
                              {col.type}
                            </span>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {!tableData?.rows || tableData.rows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={(tableData?.columns?.length ?? 1) + 1}
                          className="py-10 text-center text-slate-400 text-xs"
                        >
                          {loadingData ? 'Loading records…' : 'No records found in this table.'}
                        </td>
                      </tr>
                    ) : (
                      tableData.rows.map((row, rowIdx) => {
                        const rowNumber = (currentPage - 1) * pageSize + rowIdx + 1;
                        return (
                          <tr key={rowIdx} className="hover:bg-blue-50/40 transition-colors">
                            <td className="py-1 px-2 text-center text-slate-400 font-mono text-[10px] border-r border-slate-100 select-none">
                              {rowNumber}
                            </td>
                            {tableData.columns.map((col) => {
                              const val = row[col.name];
                              const isNull = val === null || val === undefined;
                              const strVal = String(val ?? '');
                              const isLong = strVal.length > 50;
                              const isVector = strVal.includes('dims') && strVal.startsWith('[');

                              return (
                                <td
                                  key={col.name}
                                  className="py-1 px-2.5 whitespace-nowrap border-r border-slate-100 text-slate-800 font-mono text-[11px] max-w-[260px] truncate"
                                  title={strVal}
                                >
                                  {isNull ? (
                                    <span className="text-slate-400 italic font-sans text-[10px]">null</span>
                                  ) : isVector ? (
                                    <span
                                      onClick={() => setInspectCell({ column: col.name, value: strVal })}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-purple-50 text-purple-700 border border-purple-200 text-[10px] font-semibold cursor-pointer hover:bg-purple-100"
                                    >
                                      <span className="material-symbols-outlined text-[12px]">scatter_plot</span>
                                      <span>{strVal}</span>
                                    </span>
                                  ) : typeof val === 'number' ? (
                                    <span className="text-indigo-900 font-semibold">{val.toLocaleString()}</span>
                                  ) : typeof val === 'boolean' ? (
                                    <span className={val ? 'text-emerald-600 font-semibold' : 'text-red-500 font-semibold'}>
                                      {val ? 'TRUE' : 'FALSE'}
                                    </span>
                                  ) : isLong ? (
                                    <span
                                      onClick={() => setInspectCell({ column: col.name, value: strVal })}
                                      className="cursor-pointer hover:text-blue-600 hover:underline"
                                    >
                                      {strVal}
                                    </span>
                                  ) : (
                                    <span>{strVal}</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Pagination Controls */}
            {tableData && tableData.totalPages > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-slate-600">
                <div className="text-[11px]">
                  Showing <strong className="text-slate-900">{Math.min((currentPage - 1) * pageSize + 1, tableData.filteredRows)}</strong> to{' '}
                  <strong className="text-slate-900">{Math.min(currentPage * pageSize, tableData.filteredRows)}</strong> of{' '}
                  <strong className="text-slate-900">{tableData.filteredRows.toLocaleString()}</strong> rows
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1 || loadingData}
                    className="p-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                    title="First page"
                  >
                    <span className="material-symbols-outlined text-[15px]">first_page</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1 || loadingData}
                    className="p-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                    title="Previous page"
                  >
                    <span className="material-symbols-outlined text-[15px]">chevron_left</span>
                  </button>

                  <span className="px-2 font-semibold text-slate-800 text-[11px]">
                    {currentPage} / {tableData.totalPages}
                  </span>

                  <button
                    type="button"
                    onClick={() => setCurrentPage(prev => Math.min(tableData.totalPages, prev + 1))}
                    disabled={currentPage === tableData.totalPages || loadingData}
                    className="p-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                    title="Next page"
                  >
                    <span className="material-symbols-outlined text-[15px]">chevron_right</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCurrentPage(tableData.totalPages)}
                    disabled={currentPage === tableData.totalPages || loadingData}
                    className="p-1 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
                    title="Last page"
                  >
                    <span className="material-symbols-outlined text-[15px]">last_page</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== TAB 2: SQL CONSOLE ==================== */}
      {activeTab === 'query' && (
        <div className="bg-white border border-slate-200/90 rounded-xl p-3.5 space-y-3 shadow-2xs">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                <span className="material-symbols-outlined text-blue-600 text-[18px]">terminal</span>
                <span>Direct HANA SQL Read-Only Query Console</span>
              </h3>
              <p className="text-[11px] text-slate-500">
                Execute safe read-only SQL SELECT queries directly against SAP HANA Cloud.
              </p>
            </div>
            <span className="text-[11px] font-mono text-slate-500 bg-slate-50 px-2 py-0.5 rounded border border-slate-200">
              Schema: {stats?.schema}
            </span>
          </div>

          {/* Quick Query Templates */}
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-slate-400 text-[11px] font-semibold">Templates:</span>
            {[
              {
                label: 'Top 10 Sales Records',
                query: 'SELECT * FROM "SALES_ANALYTICS" LIMIT 10',
              },
              {
                label: 'Vector Table Sample',
                query: 'SELECT "ID", "TEXT_CHUNK", "CREATED_AT" FROM "VECTOR_TABLE" LIMIT 10',
              },
              {
                label: 'Revenue by Category',
                query: 'SELECT "CATEGORY", COUNT(*) AS RECORD_COUNT, SUM("NETREVENUEUSD") AS TOTAL_REVENUE FROM "SALES_ANALYTICS" GROUP BY "CATEGORY" ORDER BY TOTAL_REVENUE DESC',
              },
              {
                label: 'System Catalog Overview',
                query: 'SELECT TABLE_NAME, RECORD_COUNT FROM SYS.M_TABLES WHERE SCHEMA_NAME = CURRENT_SCHEMA ORDER BY RECORD_COUNT DESC',
              },
            ].map((tmpl) => (
              <button
                key={tmpl.label}
                type="button"
                onClick={() => setSqlQuery(tmpl.query)}
                className="px-2 py-0.5 rounded bg-slate-100 hover:bg-blue-50 hover:text-blue-700 text-slate-700 border border-slate-200 transition-colors text-[11px] cursor-pointer"
              >
                {tmpl.label}
              </button>
            ))}
          </div>

          {/* SQL Input Area */}
          <div className="relative">
            <textarea
              rows={3}
              value={sqlQuery}
              onChange={(e) => setSqlQuery(e.target.value)}
              className="w-full font-mono text-xs p-3 bg-slate-900 text-emerald-400 rounded-lg outline-none border border-slate-800 focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              placeholder="SELECT * FROM &quot;SALES_ANALYTICS&quot; LIMIT 10"
            />
          </div>

          {/* Execute Button */}
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={handleExecuteSql}
              disabled={executingQuery || !sqlQuery.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-2xs transition-colors cursor-pointer disabled:opacity-50"
            >
              {executingQuery ? (
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <span className="material-symbols-outlined text-[16px]">play_arrow</span>
              )}
              <span>{executingQuery ? 'Running…' : 'Run Query'}</span>
            </button>
          </div>

          {/* Query Error */}
          {queryError && (
            <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-start gap-2">
              <span className="material-symbols-outlined text-red-600 text-base mt-0.5">error</span>
              <div>
                <p className="font-bold">Execution Failed</p>
                <p className="mt-0.5 font-mono text-[11px]">{queryError}</p>
              </div>
            </div>
          )}

          {/* Query Results Table */}
          {queryResult && (
            <div className="space-y-2 pt-2 border-t border-slate-200">
              <div className="flex items-center justify-between text-xs text-slate-600">
                <div className="flex items-center gap-2 text-[11px]">
                  <strong className="text-slate-900">{queryResult.rowCount} rows</strong>
                  <span>•</span>
                  <span>Executed in <strong className="text-slate-900">{queryResult.executionTimeMs} ms</strong></span>
                  {queryResult.truncated && (
                    <span className="text-amber-600 font-medium">(Capped at max limit)</span>
                  )}
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg overflow-x-auto max-h-[350px]">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="bg-slate-100 sticky top-0 border-b border-slate-200">
                    <tr>
                      {queryResult.columns.map((c) => (
                        <th key={c} className="py-1.5 px-2.5 font-mono font-bold text-slate-700 whitespace-nowrap border-r border-slate-200 text-[11px]">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {queryResult.rows.map((row, i) => (
                      <tr key={i} className="hover:bg-slate-50 transition-colors">
                        {queryResult.columns.map((c) => (
                          <td key={c} className="py-1.5 px-2.5 whitespace-nowrap font-mono text-[11px] text-slate-800 border-r border-slate-100 max-w-[260px] truncate" title={String(row[c] ?? '')}>
                            {row[c] === null ? (
                              <span className="text-slate-400 italic">null</span>
                            ) : (
                              String(row[c])
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ==================== TAB 3: SCHEMA CATALOG ==================== */}
      {activeTab === 'schema' && (
        <div className="bg-white border border-slate-200/90 rounded-xl p-3.5 space-y-3 shadow-2xs">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-purple-600 text-[18px]">schema</span>
              <span>SAP HANA Cloud Column Definitions Catalog</span>
            </h3>
            <p className="text-[11px] text-slate-500">
              Technical column structures, data types, and length constraints across all detected tables.
            </p>
          </div>

          <div className="space-y-2">
            {tables.map((table) => (
              <details
                key={table.name}
                open={table.name === selectedTableName}
                className="border border-slate-200 rounded-lg overflow-hidden group"
              >
                <summary className="px-3 py-1.5 bg-slate-50 hover:bg-slate-100/80 transition-colors flex items-center justify-between cursor-pointer select-none">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-slate-500 text-[16px] group-open:rotate-90 transition-transform">
                      chevron_right
                    </span>
                    <span className="font-mono font-bold text-xs text-slate-900">{table.name}</span>
                    <span className={`text-[9px] px-1.5 py-0.2 rounded font-mono font-semibold ${
                      table.isInternal ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-800'
                    }`}>
                      {table.isInternal ? 'Internal' : 'Business'}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-[11px] text-slate-500">
                    <span>{table.columnCount} fields</span>
                    <span>{table.rowCount.toLocaleString()} rows</span>
                  </div>
                </summary>

                <div className="p-2 border-t border-slate-200 overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 font-semibold text-[11px]">
                        <th className="py-1 px-2 w-10 text-center">Pos</th>
                        <th className="py-1 px-2">Column Name</th>
                        <th className="py-1 px-2">Data Type</th>
                        <th className="py-1 px-2">Length / Scale</th>
                        <th className="py-1 px-2">Nullable</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                      {table.columns.map((col) => (
                        <tr key={col.name} className="hover:bg-slate-50">
                          <td className="py-1 px-2 text-center text-slate-400">{col.position ?? '—'}</td>
                          <td className="py-1 px-2 font-bold text-slate-800">{col.name}</td>
                          <td className="py-1 px-2 text-blue-700 font-semibold">{col.type}</td>
                          <td className="py-1 px-2 text-slate-600">
                            {col.length ? `${col.length}${col.scale ? `, ${col.scale}` : ''}` : '—'}
                          </td>
                          <td className="py-1 px-2">
                            <span className={col.isNullable ? 'text-slate-500' : 'text-amber-600 font-bold'}>
                              {col.isNullable ? 'YES' : 'NO'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))}
          </div>
        </div>
      )}

      {/* ==================== MODAL: DELETE RANGE ("from where to where") ==================== */}
      {showDeleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs animate-in fade-in duration-100">
          <div className="relative w-full max-w-lg bg-white rounded-xl shadow-2xl border border-rose-200 overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-rose-100 bg-rose-50/70">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-rose-600 text-[20px]">delete_sweep</span>
                <div>
                  <h3 className="font-bold text-xs text-rose-950 font-mono">
                    Delete Records: {selectedTableName}
                  </h3>
                  <p className="text-[10px] text-rose-700">Specify range of records to delete permanently</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 space-y-3.5 text-xs">
              {/* Mode Switcher */}
              <div className="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
                <button
                  type="button"
                  onClick={() => setDeleteMode('row_range')}
                  className={`flex-1 py-1 px-2 rounded-md font-medium text-center transition-all cursor-pointer ${
                    deleteMode === 'row_range' ? 'bg-white text-rose-700 font-bold shadow-2xs' : 'text-slate-600'
                  }`}
                >
                  Row Range (From - To)
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteMode('id_range')}
                  className={`flex-1 py-1 px-2 rounded-md font-medium text-center transition-all cursor-pointer ${
                    deleteMode === 'id_range' ? 'bg-white text-rose-700 font-bold shadow-2xs' : 'text-slate-600'
                  }`}
                >
                  ID Range (From - To)
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteMode('condition')}
                  className={`flex-1 py-1 px-2 rounded-md font-medium text-center transition-all cursor-pointer ${
                    deleteMode === 'condition' ? 'bg-white text-rose-700 font-bold shadow-2xs' : 'text-slate-600'
                  }`}
                >
                  WHERE Condition
                </button>
              </div>

              {/* Mode 1: Row Range ("from where to where") */}
              {deleteMode === 'row_range' && (
                <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        From Row # (Start):
                      </label>
                      <input
                        type="number"
                        min={1}
                        value={deleteFromRow}
                        onChange={(e) => setDeleteFromRow(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-full px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        To Row # (End):
                      </label>
                      <input
                        type="number"
                        min={deleteFromRow}
                        value={deleteToRow}
                        onChange={(e) => setDeleteToRow(Math.max(1, parseInt(e.target.value) || 1))}
                        className="w-full px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 pt-1">
                    Will delete up to <strong>{Math.max(0, deleteToRow - deleteFromRow + 1)}</strong> rows starting from row {deleteFromRow} to row {deleteToRow}.
                  </p>
                </div>
              )}

              {/* Mode 2: ID Range */}
              {deleteMode === 'id_range' && (
                <div className="space-y-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        From ID (Start):
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. SO-100000"
                        value={deleteFromId}
                        onChange={(e) => setDeleteFromId(e.target.value)}
                        className="w-full px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        To ID (End):
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. SO-100100"
                        value={deleteToId}
                        onChange={(e) => setDeleteToId(e.target.value)}
                        className="w-full px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-md font-mono"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 pt-1">
                    Deletes rows where ID is between {deleteFromId || '…'} and {deleteToId || '…'}.
                  </p>
                </div>
              )}

              {/* Mode 3: Custom Condition */}
              {deleteMode === 'condition' && (
                <div className="space-y-1.5 bg-slate-50 p-3 rounded-lg border border-slate-200">
                  <label className="block text-[11px] font-semibold text-slate-700">
                    WHERE Clause Condition:
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. CREATED_AT < '2024-01-01' or YEAR = 2022"
                    value={deleteCondition}
                    onChange={(e) => setDeleteCondition(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-md font-mono"
                  />
                  <p className="text-[10px] text-slate-500">
                    Do not include the word "WHERE". Example: <code className="font-mono text-slate-700">YEAR = 2023</code>
                  </p>
                </div>
              )}

              {/* Warning Notice */}
              <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-[11px] text-rose-800 flex items-start gap-2">
                <span className="material-symbols-outlined text-rose-600 text-base shrink-0 mt-0.2">warning</span>
                <span>
                  <strong>Warning:</strong> Deleting records from SAP HANA Cloud is irreversible and will permanently remove matching data.
                </span>
              </div>

              {/* Confirmation Checkbox */}
              <label className="flex items-center gap-2 text-[11px] font-medium text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={confirmDeleteCheck}
                  onChange={(e) => setConfirmDeleteCheck(e.target.checked)}
                  className="rounded text-rose-600 focus:ring-rose-500 h-3.5 w-3.5 cursor-pointer"
                />
                <span>I confirm that I want to delete the specified range of records.</span>
              </label>

              {deleteError && (
                <div role="alert" className="p-2 rounded bg-red-100 text-red-900 text-[11px] font-medium">
                  {deleteError}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setShowDeleteModal(false)}
                className="px-3 py-1 rounded-md text-xs font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={handleExecuteDelete}
                disabled={isDeleting || !confirmDeleteCheck}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white shadow-2xs transition-colors cursor-pointer disabled:opacity-40"
              >
                {isDeleting ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span className="material-symbols-outlined text-[15px]">delete_forever</span>
                )}
                <span>{isDeleting ? 'Deleting…' : 'Delete Records'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================== MODAL: VIEW TABLE & ROW DETAILS ==================== */}
      {showViewModal && selectedTableObj && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs animate-in fade-in duration-100">
          <div className="relative w-full max-w-xl bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-indigo-600 text-[18px]">visibility</span>
                <div>
                  <h3 className="font-bold text-xs text-slate-900 font-mono">
                    Table Overview: {selectedTableObj.name}
                  </h3>
                  <p className="text-[10px] text-slate-500">Summary statistics & structure preview</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowViewModal(false)}
                className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>

            {/* Body */}
            <div className="p-4 space-y-3.5 overflow-y-auto text-xs">
              {/* Metric stats grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-center">
                  <span className="text-[10px] text-slate-500 block">Total Rows</span>
                  <span className="font-bold text-sm text-slate-900 font-mono">
                    {selectedTableObj.rowCount.toLocaleString()}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-center">
                  <span className="text-[10px] text-slate-500 block">Columns</span>
                  <span className="font-bold text-sm text-slate-900 font-mono">
                    {selectedTableObj.columnCount}
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-center">
                  <span className="text-[10px] text-slate-500 block">Storage Type</span>
                  <span className="font-bold text-xs text-blue-700 font-mono">
                    {selectedTableObj.type} TABLE
                  </span>
                </div>
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-center">
                  <span className="text-[10px] text-slate-500 block">Classification</span>
                  <span className={`font-bold text-xs font-mono ${selectedTableObj.isInternal ? 'text-slate-700' : 'text-emerald-700'}`}>
                    {selectedTableObj.isInternal ? 'Internal' : 'Business'}
                  </span>
                </div>
              </div>

              {/* Sample Record Preview */}
              {tableData && tableData.rows.length > 0 && (
                <div className="space-y-1">
                  <span className="text-[11px] font-bold text-slate-700">Sample Row 1 (JSON Key-Value Preview):</span>
                  <pre className="font-mono text-[11px] bg-slate-900 text-slate-100 p-3 rounded-lg max-h-[220px] overflow-y-auto whitespace-pre-wrap break-all">
                    {JSON.stringify(tableData.rows[0], null, 2)}
                  </pre>
                </div>
              )}

              {/* Quick DDL syntax */}
              <div className="space-y-1">
                <span className="text-[11px] font-bold text-slate-700">Fields Summary:</span>
                <div className="border border-slate-200 rounded-lg max-h-[160px] overflow-y-auto">
                  <table className="w-full text-left text-[11px] font-mono">
                    <thead className="bg-slate-100 text-slate-600 sticky top-0">
                      <tr>
                        <th className="py-1 px-2">Column</th>
                        <th className="py-1 px-2">Type</th>
                        <th className="py-1 px-2">Nullable</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {selectedTableObj.columns.map((c) => (
                        <tr key={c.name} className="hover:bg-slate-50">
                          <td className="py-0.5 px-2 font-bold text-slate-800">{c.name}</td>
                          <td className="py-0.5 px-2 text-blue-700">{c.type}</td>
                          <td className="py-0.5 px-2 text-slate-500">{c.isNullable ? 'YES' : 'NO'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 text-right">
              <button
                type="button"
                onClick={() => setShowViewModal(false)}
                className="px-3 py-1 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Inspect Cell Modal (When user clicks on long text like TEXT_CHUNK or METADATA) */}
      {inspectCell && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs animate-in fade-in duration-100">
          <div className="relative w-full max-w-xl bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-blue-600 text-[18px]">data_object</span>
                <span className="font-bold text-xs text-slate-900 font-mono">
                  {selectedTableName} · {inspectCell.column}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setInspectCell(null)}
                className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-200 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
              <pre className="font-mono text-xs whitespace-pre-wrap break-all bg-slate-900 text-slate-100 p-3 rounded-lg max-h-[400px] overflow-y-auto">
                {inspectCell.value}
              </pre>
            </div>

            <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
              <button
                type="button"
                onClick={handleCopyCell}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px]">
                  {copiedCell ? 'check' : 'content_copy'}
                </span>
                <span>{copiedCell ? 'Copied!' : 'Copy to Clipboard'}</span>
              </button>

              <button
                type="button"
                onClick={() => setInspectCell(null)}
                className="px-3 py-1 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Columns Modal for Selected Table */}
      {showColumnsModal && selectedTableObj && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-2xs animate-in fade-in duration-100">
          <div className="relative w-full max-w-xl bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
              <div>
                <h3 className="font-bold text-xs text-slate-900 font-mono">{selectedTableObj.name}</h3>
                <p className="text-[10px] text-slate-500">Column Definitions ({selectedTableObj.columns.length} columns)</p>
              </div>
              <button
                type="button"
                onClick={() => setShowColumnsModal(false)}
                className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-200 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>

            <div className="p-3 overflow-y-auto flex-1">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 font-semibold text-[11px]">
                    <th className="py-1 px-2 w-10 text-center">Pos</th>
                    <th className="py-1 px-2">Field</th>
                    <th className="py-1 px-2">SQL Data Type</th>
                    <th className="py-1 px-2">Length</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 font-mono text-[11px]">
                  {selectedTableObj.columns.map((col, idx) => (
                    <tr key={col.name} className="hover:bg-slate-50">
                      <td className="py-1 px-2 text-center text-slate-400">{col.position ?? idx + 1}</td>
                      <td className="py-1 px-2 font-bold text-slate-800">{col.name}</td>
                      <td className="py-1 px-2 text-blue-700 font-semibold">{col.type}</td>
                      <td className="py-1 px-2 text-slate-600">{col.length ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 text-right">
              <button
                type="button"
                onClick={() => setShowColumnsModal(false)}
                className="px-3 py-1 rounded-md text-xs font-semibold bg-slate-200 text-slate-800 hover:bg-slate-300 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
