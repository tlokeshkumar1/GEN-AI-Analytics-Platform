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
import { DatasetIndexStatus } from './DatasetStatusBadge';
import { agentActivityStore } from '../../services/agentActivityStore';

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

    setRows((prev) =>
      prev.map((r) => {
        if ((r.__rowId ?? r.id) === rowId) {
          return { ...r, [colName]: newValue };
        }
        return r;
      })
    );

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
    <div className={`bg-[var(--color-background-surface)] rounded-[var(--radius-container)] border border-[var(--color-border)] shadow-[var(--shadow-xs)] overflow-hidden flex flex-col ${className}`}>
      {/* Live Dataset Version & Sync Status Ribbon */}
      <div className="px-4 sm:px-5 py-2.5 bg-[var(--color-background-subtle)] border-b border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[var(--color-text-primary)]">
            Editing Version {dataset.currentVersion}
          </span>
          <span className="text-[var(--color-text-muted)]">·</span>
          <span className="text-[var(--color-text-secondary)]">
            {dataset.name} ({dataset.rowCount.toLocaleString()} rows)
          </span>
        </div>
        <DatasetIndexStatus dataset={dataset} />
      </div>

      {/* Editor Action Header */}
      <div className="p-3 sm:p-4 border-b border-[var(--color-border)] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[var(--color-background-surface)]">
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-3.5 h-3.5 text-[var(--color-text-muted)] absolute left-3 top-2.5 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search rows to edit…"
              className="w-full pl-9 pr-3.5 py-1.5 text-xs rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder-[var(--color-text-placeholder)] focus:outline-none focus:border-[var(--color-primary)]"
            />
          </div>

          {/* Unsaved Changes Indicator */}
          {isDirty && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-[var(--radius-full)] bg-[var(--color-warning-soft)] text-[var(--color-warning)] border border-[var(--color-warning-muted)] text-[11px] font-medium animate-pulse">
              <AlertTriangle className="w-3 h-3 text-[var(--color-warning)]" />
              <span>{dirtyRowIds.size} unsaved row(s)</span>
            </span>
          )}

          {hasErrors && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-[var(--radius-full)] bg-[var(--color-error-soft)] text-[var(--color-error)] border border-[var(--color-error-muted)] text-[11px] font-medium">
              <AlertCircle className="w-3 h-3 text-[var(--color-error)]" />
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
              className="h-8 px-3 rounded-[var(--radius-element)] border border-[var(--color-primary-muted)] bg-[var(--color-primary-soft)] text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)] transition-colors flex items-center gap-1.5 text-xs font-medium shadow-[var(--shadow-xs)] cursor-pointer"
              title="Open and update the semantic model definitions for this dataset"
            >
              <span className="material-symbols-outlined text-[15px]">account_tree</span>
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
            className="h-8 px-3 rounded-[var(--radius-element)] border border-[var(--color-ai-muted)] bg-[var(--color-ai-soft)] text-[var(--color-ai)] hover:bg-[var(--color-ai-muted)] transition-colors flex items-center gap-1.5 text-xs font-medium shadow-[var(--shadow-xs)] cursor-pointer"
            title="View autonomous 3-agent ingestion activity"
          >
            <span className="material-symbols-outlined text-[15px]">smart_toy</span>
            <span>Agent Activity</span>
          </button>

          <button
            type="button"
            onClick={handleCancelClick}
            disabled={!isDirty || isSaving}
            className="h-8 px-3 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-background-muted)] hover:text-[var(--color-text-primary)] transition-colors flex items-center gap-1.5 text-xs font-medium shadow-[var(--shadow-xs)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Discard</span>
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || hasErrors || isSaving}
            className="h-8 px-4 rounded-[var(--radius-element)] bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors flex items-center gap-1.5 text-xs font-medium shadow-[var(--shadow-xs)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {isSaving ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            <span>{isSaving ? 'Saving…' : 'Save Changes'}</span>
          </button>
        </div>
      </div>

      {/* Just Saved Notification with Direct Action to Semantic Model */}
      {justSaved && (
        <div className="mx-4 sm:mx-5 my-2.5 p-3 rounded-[var(--radius-element)] bg-[var(--color-success-soft)] border border-[var(--color-success-muted)] flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--color-success)] animate-fadeIn">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[var(--color-success)] shrink-0" />
            <span>Changes saved! Physical table &amp; VECTOR_TABLE updated incrementally.</span>
          </div>
          {onProceedToSemanticModel && (
            <button
              type="button"
              onClick={onProceedToSemanticModel}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-success)] hover:opacity-90 text-white font-medium text-xs transition-colors shadow-[var(--shadow-xs)] cursor-pointer"
            >
              <span>Proceed to Semantic Model</span>
              <span className="material-symbols-outlined text-[13px]">arrow_forward</span>
            </button>
          )}
        </div>
      )}

      {/* Editable Table Body */}
      <div className="overflow-x-auto flex-1 min-h-[360px]">
        {isLoading ? (
          <div className="py-24 flex flex-col items-center justify-center gap-2 text-[var(--color-text-muted)] text-xs">
            <RefreshCw className="w-5 h-5 animate-spin text-[var(--color-primary)]" />
            <span>Loading rows for editing…</span>
          </div>
        ) : (
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-[var(--color-background-subtle)] text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
                <th className="py-2.5 px-3 w-12 text-center uppercase tracking-wider text-[11px] font-medium">
                  Status
                </th>
                {dataset.columns.map((col) => (
                  <th key={col.name} className="py-2.5 px-3 font-medium uppercase tracking-wider text-[11px]">
                    <div className="flex items-center gap-1">
                      <span>{col.name}</span>
                      {col.required && <span className="text-[var(--color-error)]">*</span>}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)] text-[var(--color-text-primary)]">
              {filteredRows.map((row) => {
                const isRowDirty = dirtyRowIds.has((row.__rowId ?? row.id));
                const rowErrors = validationErrors[(row.__rowId ?? row.id)] || {};

                return (
                  <tr
                    key={(row.__rowId ?? row.id)}
                    className={`transition-colors ${
                      isRowDirty ? 'bg-[var(--color-warning-soft)]/50 hover:bg-[var(--color-warning-soft)]' : 'hover:bg-[var(--color-background-subtle)]'
                    }`}
                  >
                    {/* Status marker */}
                    <td className="py-2 px-3 text-center align-middle">
                      {isRowDirty ? (
                        <span className="w-2 h-2 rounded-full bg-[var(--color-warning)] inline-block" title="Unsaved row" />
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-border-strong)] inline-block" />
                      )}
                    </td>

                    {/* Editable cell fields */}
                    {dataset.columns.map((col) => {
                      const val = row[col.name];
                      const fieldError = rowErrors[col.name];

                      return (
                        <td key={col.name} className="py-1.5 px-2.5 align-middle">
                          <div className="relative">
                            <input
                              type={col.type === 'number' || col.type === 'percentage' ? 'number' : col.type === 'date' ? 'date' : 'text'}
                              step={col.type === 'percentage' ? '0.1' : col.type === 'number' ? '0.01' : undefined}
                              value={val ?? ''}
                              onChange={(e) => handleCellChange((row.__rowId ?? row.id), col.name, e.target.value)}
                              className={`w-full px-2 py-1 rounded-[var(--radius-inner)] text-xs font-sans transition-all border ${
                                fieldError
                                  ? 'border-[var(--color-error)] bg-[var(--color-error-soft)] text-[var(--color-error)]'
                                  : isRowDirty
                                  ? 'border-[var(--color-warning)] bg-[var(--color-background-surface)] focus:border-[var(--color-primary)]'
                                  : 'border-[var(--color-border)] bg-[var(--color-background-surface)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-primary)]'
                              } ${col.type === 'number' || col.type === 'percentage' ? 'text-right font-mono' : ''}`}
                              title={fieldError || `${col.name} (${col.type})`}
                            />
                            {fieldError && (
                              <span className="text-[10px] text-[var(--color-error)] block mt-0.5 font-medium truncate max-w-[140px]">
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
          <div className="bg-[var(--color-background-surface)] rounded-[var(--radius-container)] shadow-[var(--shadow-xl)] max-w-md w-full p-5 border border-[var(--color-border)] space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-[var(--radius-element)] bg-[var(--color-warning-soft)] text-[var(--color-warning)] flex items-center justify-center shrink-0 border border-[var(--color-warning-muted)]">
                <AlertTriangle className="w-4 h-4" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-[var(--color-text-primary)]">Discard Unsaved Changes?</h3>
                <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                  You have modified {dirtyRowIds.size} row(s). Any edits will be permanently reverted.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowDiscardConfirm(false)}
                className="px-3.5 py-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-background-muted)] cursor-pointer"
              >
                Keep Editing
              </button>
              <button
                type="button"
                onClick={handleConfirmDiscard}
                className="px-3.5 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-error)] text-white text-xs font-medium hover:opacity-90 shadow-[var(--shadow-xs)] cursor-pointer"
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
