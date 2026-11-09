import React, { useState, useEffect } from 'react';
import {
  Save,
  RotateCcw,
  Check,
  AlertCircle,
  Edit2,
  FileSpreadsheet,
  AlertTriangle,
  RefreshCw,
  Search,
  CheckCircle2,
} from 'lucide-react';
import { DatasetItem, DatasetRow, DatasetColumn } from '../../types/dataset';
import { getDatasetData, updateDatasetRows } from '../../services/datasetService';
import { DatasetStatusBadge } from './DatasetStatusBadge';

interface DatasetEditViewProps {
  dataset: DatasetItem;
  onSaved: (updatedDataset?: DatasetItem) => void;
  onToast: (message: string) => void;
  onProceedToSemanticModel?: () => void;
  className?: string;
}

export const DatasetEditView: React.FC<DatasetEditViewProps> = ({
  dataset,
  onSaved,
  onToast,
  onProceedToSemanticModel,
  className = '',
}) => {
  const [rows, setRows] = useState<DatasetRow[]>([]);
  const [originalRows, setOriginalRows] = useState<DatasetRow[]>([]);
  const [dirtyRowIds, setDirtyRowIds] = useState<Set<string>>(new Set());
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<Record<string, Record<string, string>>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const fetchRows = async () => {
    setIsLoading(true);
    try {
      const data = await getDatasetData(dataset.id, 1, 50);
      setRows(data.rows);
      setOriginalRows(JSON.parse(JSON.stringify(data.rows)));
      setDirtyRowIds(new Set());
      setValidationErrors({});
      setEditingRowId(null);
    } catch (err) {
      console.error('Failed to load dataset rows for editing:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRows();
  }, [dataset.id, dataset.currentVersion]);

  // Validation function for a given column value
  const validateField = (col: DatasetColumn, value: any): string | null => {
    if (col.required && (value === undefined || value === null || String(value).trim() === '')) {
      return `${col.name} is required`;
    }
    if (col.type === 'number') {
      if (value !== '' && isNaN(Number(value))) {
        return `Must be a valid number`;
      }
    }
    if (col.type === 'percentage') {
      const num = Number(value);
      if (isNaN(num)) {
        return `Must be a number`;
      }
      if (num < 0 || num > 100) {
        return `Must be between 0 and 100%`;
      }
    }
    return null;
  };

  const handleCellChange = (rowId: string, colName: string, newValue: any) => {
    const colDef = dataset.columns.find((c) => c.name === colName);
    const errorMsg = colDef ? validateField(colDef, newValue) : null;

    // Update validation errors
    setValidationErrors((prev) => {
      const rowErrors = { ...(prev[rowId] || {}) };
      if (errorMsg) {
        rowErrors[colName] = errorMsg;
      } else {
        delete rowErrors[colName];
      }
      const next = { ...prev };
      if (Object.keys(rowErrors).length > 0) {
        next[rowId] = rowErrors;
      } else {
        delete next[rowId];
      }
      return next;
    });

    // Update rows state
    setRows((prev) =>
      prev.map((r) => {
        if ((r.__rowId ?? r.id) === rowId) {
          return { ...r, [colName]: newValue };
        }
        return r;
      })
    );

    // Track dirty rows
    setDirtyRowIds((prev) => new Set(prev).add(rowId));
  };

  const hasErrors = Object.keys(validationErrors).length > 0;
  const isDirty = dirtyRowIds.size > 0;

  const handleSave = async () => {
    if (hasErrors) {
      onToast('Please resolve all validation errors before saving.');
      return;
    }
    if (!isDirty) {
      onToast('No changes detected.');
      return;
    }

    setIsSaving(true);
    try {
      const modifiedRows = rows.filter((r) => dirtyRowIds.has((r.__rowId ?? r.id))).map((r) => {
        // Coerce numbers where applicable
        const coerced: DatasetRow = { ...r };
        dataset.columns.forEach((col) => {
          if ((col.type === 'number' || col.type === 'percentage') && coerced[col.name] !== undefined) {
            coerced[col.name] = coerced[col.name] === '' ? null : String(coerced[col.name]);
          }
        });
        return coerced;
      });

      const res = await updateDatasetRows(dataset.id, modifiedRows);
      onToast(res.message);
      setOriginalRows(JSON.parse(JSON.stringify(rows)));
      setDirtyRowIds(new Set());
      setEditingRowId(null);
      setJustSaved(true);
      onSaved(res.dataset);
    } catch (err: any) {
      onToast(`Error saving changes: ${err?.message || 'Update failed'}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelClick = () => {
    if (isDirty) {
      setShowDiscardConfirm(true);
    } else {
      setEditingRowId(null);
    }
  };

  const handleConfirmDiscard = () => {
    setRows(JSON.parse(JSON.stringify(originalRows)));
    setDirtyRowIds(new Set());
    setValidationErrors({});
    setEditingRowId(null);
    setShowDiscardConfirm(false);
    onToast('Discarded unsaved modifications.');
  };

  const filteredRows = rows.filter((r) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return Object.values(r).some((val) => String(val ?? '').toLowerCase().includes(q));
  });

  return (
    <div className={`bg-white rounded-2xl border border-[#E2E8F0] shadow-xs overflow-hidden flex flex-col ${className}`}>
      {/* Live Dataset Version & Sync Status Ribbon */}
      <div className="px-4 sm:px-5 py-3 bg-slate-50 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-800">
            Editing Version {dataset.currentVersion}
          </span>
          <span className="text-slate-400">·</span>
          <span className="text-slate-600">
            {dataset.name} ({dataset.rowCount.toLocaleString()} rows)
          </span>
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

      {/* Editor Action Header */}
      <div className="p-4 sm:p-5 border-b border-[#E2E8F0] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[#F8FAFC]">
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[#64748B] absolute left-3 top-2.5 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search rows to edit..."
              className="w-full pl-9 pr-4 py-2 text-xs rounded-xl bg-white border border-[#CBD5E1] text-[#0F172A] placeholder-[#94A3B8] focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          {/* Unsaved Changes Indicator */}
          {isDirty && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 text-xs font-semibold animate-pulse">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              <span>{dirtyRowIds.size} unsaved row(s)</span>
            </span>
          )}

          {hasErrors && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200 text-xs font-semibold">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>Validation errors present</span>
            </span>
          )}
        </div>

        {/* Save / Discard / Semantic Actions */}
        <div className="flex items-center gap-2 self-end sm:self-auto flex-wrap">
          {onProceedToSemanticModel && (
            <button
              type="button"
              onClick={onProceedToSemanticModel}
              className="h-9 px-3.5 rounded-xl border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors flex items-center gap-1.5 text-xs font-semibold shadow-2xs cursor-pointer"
              title="Open and update the semantic model definitions for this dataset"
            >
              <span className="material-symbols-outlined text-[16px] text-blue-600">account_tree</span>
              <span>Update Semantic Model</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleCancelClick}
            disabled={!isDirty || isSaving}
            className="h-9 px-4 rounded-xl border border-[#CBD5E1] bg-white text-[#475569] hover:bg-[#F1F5F9] hover:text-[#0F172A] transition-colors flex items-center gap-1.5 text-xs font-semibold shadow-2xs disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Discard</span>
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || hasErrors || isSaving}
            className="h-9 px-5 rounded-xl bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition-colors flex items-center gap-2 text-xs font-semibold shadow-xs disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {isSaving ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            <span>{isSaving ? 'Saving...' : 'Save Changes'}</span>
          </button>
        </div>
      </div>

      {/* Just Saved Notification with Direct Action to Semantic Model */}
      {justSaved && (
        <div className="mx-4 sm:mx-5 my-2.5 p-3 rounded-xl bg-emerald-50 border border-emerald-200 flex flex-wrap items-center justify-between gap-3 text-xs text-emerald-800 animate-fadeIn">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Changes saved! Physical table &amp; VECTOR_TABLE updated incrementally.</span>
          </div>
          {onProceedToSemanticModel && (
            <button
              type="button"
              onClick={onProceedToSemanticModel}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs transition-colors shadow-2xs cursor-pointer"
            >
              <span>Proceed to Semantic Model</span>
              <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
            </button>
          )}
        </div>
      )}

      {/* Editable Table Body */}
      <div className="overflow-x-auto flex-1 min-h-[380px]">
        {isLoading ? (
          <div className="py-24 flex flex-col items-center justify-center gap-2 text-slate-500 text-xs">
            <RefreshCw className="w-6 h-6 animate-spin text-[#2563EB]" />
            <span>Loading rows for editing...</span>
          </div>
        ) : (
          <table className="w-full text-left border-collapse font-body-sm text-xs">
            <thead>
              <tr className="bg-[#F8FAFC] text-[#475569] border-b border-[#E2E8F0]">
                <th className="py-3 px-3 w-12 text-center uppercase tracking-wider text-[11px] font-semibold">
                  Status
                </th>
                {dataset.columns.map((col) => (
                  <th key={col.name} className="py-3 px-3 font-semibold uppercase tracking-wider text-[11px]">
                    <div className="flex items-center gap-1">
                      <span>{col.name}</span>
                      {col.required && <span className="text-rose-500">*</span>}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] text-[#0F172A]">
              {filteredRows.map((row) => {
                const isRowDirty = dirtyRowIds.has((row.__rowId ?? row.id));
                const rowErrors = validationErrors[(row.__rowId ?? row.id)] || {};

                return (
                  <tr
                    key={(row.__rowId ?? row.id)}
                    className={`transition-colors ${
                      isRowDirty ? 'bg-amber-50/40 hover:bg-amber-50/70' : 'hover:bg-[#F8FAFC]'
                    }`}
                  >
                    {/* Status marker */}
                    <td className="py-2 px-3 text-center align-middle">
                      {isRowDirty ? (
                        <span className="w-2 h-2 rounded-full bg-amber-500 inline-block" title="Unsaved row" />
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 inline-block" />
                      )}
                    </td>

                    {/* Editable cell fields */}
                    {dataset.columns.map((col) => {
                      const val = row[col.name];
                      const fieldError = rowErrors[col.name];

                      return (
                        <td key={col.name} className="py-2 px-2.5 align-middle">
                          <div className="relative">
                            <input
                              type={col.type === 'number' || col.type === 'percentage' ? 'number' : col.type === 'date' ? 'date' : 'text'}
                              step={col.type === 'percentage' ? '0.1' : col.type === 'number' ? '0.01' : undefined}
                              value={val ?? ''}
                              onChange={(e) => handleCellChange((row.__rowId ?? row.id), col.name, e.target.value)}
                              className={`w-full px-2.5 py-1.5 rounded-lg text-xs font-sans transition-all border ${
                                fieldError
                                  ? 'border-rose-400 bg-rose-50/60 text-rose-900 focus:ring-1 focus:ring-rose-500'
                                  : isRowDirty
                                  ? 'border-amber-300 bg-white focus:border-[#2563EB] focus:ring-1 focus:ring-[#2563EB]/20'
                                  : 'border-[#CBD5E1] bg-white hover:border-slate-400 focus:border-[#2563EB] focus:ring-1 focus:ring-[#2563EB]/20'
                              } ${col.type === 'number' || col.type === 'percentage' ? 'text-right font-mono' : ''}`}
                              title={fieldError || `${col.name} (${col.type})`}
                            />
                            {fieldError && (
                              <span className="text-[10px] text-rose-600 block mt-0.5 font-medium truncate max-w-[140px]">
                                {fieldError}
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Discard Confirmation Dialog */}
      {showDiscardConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 border border-[#CBD5E1] space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center shrink-0 border border-amber-200">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-[#0F172A]">Discard Unsaved Changes?</h3>
                <p className="text-xs text-[#64748B] mt-0.5">
                  You have modified {dirtyRowIds.size} row(s). Any edits will be permanently reverted.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowDiscardConfirm(false)}
                className="px-4 py-2 rounded-xl border border-[#CBD5E1] text-xs font-semibold text-[#475569] hover:bg-[#F1F5F9]"
              >
                Keep Editing
              </button>
              <button
                type="button"
                onClick={handleConfirmDiscard}
                className="px-4 py-2 rounded-xl bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700 shadow-xs"
              >
                Discard Edits
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
