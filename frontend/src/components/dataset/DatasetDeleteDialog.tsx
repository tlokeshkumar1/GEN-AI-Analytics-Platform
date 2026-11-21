import React, { useState, useEffect } from 'react';
import {
  Trash2,
  AlertTriangle,
  Layers,
  FileSpreadsheet,
  X,
  RefreshCw,
  Check,
} from 'lucide-react';
import { DatasetItem, DatasetRow } from '../../types/dataset';
import {
  getDatasetData,
  deleteDatasetRows,
  deleteDataset,
} from '../../services/datasetService';
import { invalidateDashboardCache } from '../../screens/ExecutiveDashboard';
import { selectedContext, selectContext } from '../../services/executionContext';

interface DatasetDeleteDialogProps {
  dataset: DatasetItem;
  isOpen: boolean;
  onClose: () => void;
  onDatasetDeleted: () => void;
  onRowsDeleted: () => void;
  onToast: (msg: string) => void;
}

export const DatasetDeleteDialog: React.FC<DatasetDeleteDialogProps> = ({
  dataset,
  isOpen,
  onClose,
  onDatasetDeleted,
  onRowsDeleted,
  onToast,
}) => {
  const [deleteMode, setDeleteMode] = useState<'rows' | 'full'>('rows');
  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [sampleRows, setSampleRows] = useState<DatasetRow[]>([]);
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLoadingRows, setIsLoadingRows] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTypedConfirmation('');
      setSelectedRowIds(new Set());
      setDeleteMode('rows');

      // Load rows for selection
      setIsLoadingRows(true);
      getDatasetData(dataset.id, 1, 20)
        .then((data) => {
          setSampleRows(data.rows);
        })
        .catch(console.error)
        .finally(() => setIsLoadingRows(false));
    }
  }, [isOpen, dataset.id]);

  if (!isOpen) return null;

  const isNameConfirmed = typedConfirmation.trim() === dataset.name.trim();

  const handleToggleRow = (id: string) => {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSelectAllRows = () => {
    if (selectedRowIds.size === sampleRows.length) {
      setSelectedRowIds(new Set());
    } else {
      setSelectedRowIds(new Set(sampleRows.map((r) => (r.__rowId ?? r.id))));
    }
  };

  const handleExecuteDelete = async () => {
    setIsDeleting(true);
    try {
      if (deleteMode === 'rows') {
        if (selectedRowIds.size === 0) {
          onToast('Select at least one row to delete.');
          return;
        }
        const res = await deleteDatasetRows(dataset.id, Array.from(selectedRowIds));
        onToast(res.message);
        onRowsDeleted();
        onClose();
      } else {
        if (!isNameConfirmed) {
          onToast('Dataset name confirmation does not match.');
          return;
        }
        const res = await deleteDataset(dataset.id);
        if (selectedContext()?.datasetId === dataset.id) {
          selectContext(null);
        }
        invalidateDashboardCache();
        window.dispatchEvent(new CustomEvent('dashboard_updated'));
        onToast(res.message);
        onDatasetDeleted();
        onClose();
      }
    } catch (err: any) {
      onToast(`Deletion failed: ${err?.message || 'Error deleting'}`);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
    >
      <div className="bg-[var(--color-background-surface)] rounded-[var(--radius-container)] shadow-[var(--shadow-xl)] max-w-lg w-full border border-[var(--color-border)] overflow-hidden space-y-0">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-[var(--color-border)] bg-[var(--color-error-soft)]/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-[var(--radius-element)] bg-[var(--color-error-soft)] text-[var(--color-error)] flex items-center justify-center shrink-0 border border-[var(--color-error-muted)]">
              <Trash2 className="w-4 h-4" />
            </div>
            <div>
              <h2 id="delete-dialog-title" className="font-semibold text-sm text-[var(--color-text-primary)]">
                Delete Records or Dataset
              </h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 truncate max-w-xs" title={dataset.name}>
                Target: <span className="font-medium text-[var(--color-text-secondary)]">{dataset.name}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-[var(--radius-element)] hover:bg-[var(--color-background-subtle)] flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors cursor-pointer"
            aria-label="Close dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-5 space-y-4 text-xs">
          {/* Mode Tabs */}
          <div className="p-1 rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)] flex items-center gap-1">
            <button
              type="button"
              onClick={() => setDeleteMode('rows')}
              className={`flex-1 py-1.5 rounded-[var(--radius-inner)] font-medium transition-all cursor-pointer text-xs ${deleteMode === 'rows'
                ? 'bg-[var(--color-background-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-xs)] font-semibold'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
            >
              Delete Selected Rows
            </button>
            <button
              type="button"
              onClick={() => setDeleteMode('full')}
              className={`flex-1 py-1.5 rounded-[var(--radius-inner)] font-medium transition-all cursor-pointer text-xs ${deleteMode === 'full'
                ? 'bg-[var(--color-error)] text-white shadow-[var(--shadow-xs)] font-semibold'
                : 'text-[var(--color-error)] hover:opacity-80'
                }`}
            >
              Delete Entire Dataset
            </button>
          </div>

          {/* Option A: Select rows to delete */}
          {deleteMode === 'rows' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-[var(--color-text-secondary)]">
                <span>Select row items to remove:</span>
                <button
                  type="button"
                  onClick={handleSelectAllRows}
                  className="text-xs font-medium text-[var(--color-primary)] hover:underline cursor-pointer"
                >
                  {selectedRowIds.size === sampleRows.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              <div className="max-h-56 overflow-y-auto rounded-[var(--radius-element)] border border-[var(--color-border)] divide-y divide-[var(--color-border)] bg-[var(--color-background-subtle)]">
                {isLoadingRows ? (
                  <div className="py-8 text-center text-[var(--color-text-muted)]">Loading rows…</div>
                ) : sampleRows.length === 0 ? (
                  <div className="py-8 text-center text-[var(--color-text-muted)]">No rows in dataset</div>
                ) : (
                  sampleRows.map((r) => {
                    const isChecked = selectedRowIds.has((r.__rowId ?? r.id));
                    return (
                      <label
                        key={(r.__rowId ?? r.id)}
                        className={`p-2.5 flex items-center gap-3 cursor-pointer hover:bg-[var(--color-background-surface)] transition-colors ${isChecked ? 'bg-[var(--color-error-soft)]/60' : ''
                          }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleRow((r.__rowId ?? r.id))}
                          className="w-4 h-4 accent-[var(--color-error)] rounded cursor-pointer"
                        />
                        <div className="flex-1 flex items-center justify-between min-w-0">
                          <span className="font-mono font-medium text-[var(--color-text-primary)]">
                            {r.OrderNumber || (r.__rowId ?? r.id)}
                          </span>
                          <span className="text-[11px] text-[var(--color-text-muted)]">
                            {r.Product || r.Category || ''}
                          </span>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Option B: Delete entire dataset */}
          {deleteMode === 'full' && (
            <div className="space-y-3.5">
              <div className="p-3.5 rounded-[var(--radius-element)] bg-[var(--color-error-soft)] border border-[var(--color-error-muted)] text-[var(--color-error)] space-y-1.5">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="w-4 h-4 text-[var(--color-error)] shrink-0" />
                  <span>Permanent Action Warning</span>
                </div>
                <p className="text-[11px] leading-relaxed">
                  This will permanently delete <strong>{dataset.name}</strong> across all storage layers:
                </p>
                <ul className="text-[11px] list-disc list-inside space-y-0.5 mt-1 font-medium">
                  <li>Physical column tables in SAP HANA Cloud</li>
                  <li>Semantic models & analytics in PLATFORM_METADATA</li>
                  <li>Catalog entries in DATASETS_METADATA</li>
                  <li>High-dimensional embeddings in VECTOR_TABLE</li>
                  <li>Local version files, snapshots, and runtime caches</li>
                </ul>
              </div>

              <div>
                <label className="block text-[var(--color-text-secondary)] font-medium mb-1.5">
                  Type <span className="font-mono font-semibold text-[var(--color-text-primary)] bg-[var(--color-background-subtle)] px-1.5 py-0.5 rounded-[var(--radius-inner)] border border-[var(--color-border)]">{dataset.name}</span> to confirm:
                </label>
                <input
                  type="text"
                  value={typedConfirmation}
                  onChange={(e) => setTypedConfirmation(e.target.value)}
                  placeholder={dataset.name}
                  className="w-full px-3 py-2 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] focus:border-[var(--color-error)] focus:outline-none text-xs font-mono"
                  autoFocus
                />
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-3.5 sm:p-4 border-t border-[var(--color-border)] bg-[var(--color-background-subtle)] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="px-3.5 py-1.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-secondary)] text-xs font-medium cursor-pointer"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleExecuteDelete}
            disabled={
              isDeleting ||
              (deleteMode === 'rows' && selectedRowIds.size === 0) ||
              (deleteMode === 'full' && !isNameConfirmed)
            }
            className="px-4 py-1.5 rounded-[var(--radius-element)] bg-[var(--color-error)] hover:opacity-90 text-white text-xs font-medium shadow-[var(--shadow-xs)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
          >
            {isDeleting ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            <span>
              {isDeleting
                ? 'Purging from HANA & storage…'
                : deleteMode === 'rows'
                  ? `Delete ${selectedRowIds.size} Row(s)`
                  : 'Confirm & Delete Entire Dataset'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
