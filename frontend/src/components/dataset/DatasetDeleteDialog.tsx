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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-dialog-title"
    >
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full border border-slate-200 overflow-hidden space-y-0">
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-200 bg-rose-50/50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-rose-100 text-rose-700 flex items-center justify-center shrink-0 border border-rose-200">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <h2 id="delete-dialog-title" className="font-semibold text-sm text-[#0F172A]">
                Delete Records or Dataset
              </h2>
              <p className="text-xs text-[#64748B] mt-0.5 truncate max-w-xs" title={dataset.name}>
                Target: <strong>{dataset.name}</strong>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-slate-200/60 flex items-center justify-center text-slate-500 hover:text-slate-900 transition-colors cursor-pointer"
            aria-label="Close dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4 text-xs">
          {/* Mode Tabs */}
          <div className="p-1 rounded-xl bg-slate-100 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setDeleteMode('rows')}
              className={`flex-1 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                deleteMode === 'rows'
                  ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Delete Selected Rows
            </button>
            <button
              type="button"
              onClick={() => setDeleteMode('full')}
              className={`flex-1 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                deleteMode === 'full'
                  ? 'bg-rose-600 text-white shadow-2xs font-semibold'
                  : 'text-rose-700 hover:text-rose-900'
              }`}
            >
              Delete Entire Dataset
            </button>
          </div>

          {/* Option A: Select rows to delete */}
          {deleteMode === 'rows' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-slate-600">
                <span>Select row items to remove from the in-memory cache:</span>
                <button
                  type="button"
                  onClick={handleSelectAllRows}
                  className="text-xs font-semibold text-[#2563EB] hover:underline cursor-pointer"
                >
                  {selectedRowIds.size === sampleRows.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>

              <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100 bg-[#F8FAFC]">
                {isLoadingRows ? (
                  <div className="py-8 text-center text-slate-400">Loading rows...</div>
                ) : sampleRows.length === 0 ? (
                  <div className="py-8 text-center text-slate-400">No rows in dataset</div>
                ) : (
                  sampleRows.map((r) => {
                    const isChecked = selectedRowIds.has((r.__rowId ?? r.id));
                    return (
                      <label
                        key={(r.__rowId ?? r.id)}
                        className={`p-2.5 flex items-center gap-3 cursor-pointer hover:bg-white transition-colors ${
                          isChecked ? 'bg-rose-50/50' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleRow((r.__rowId ?? r.id))}
                          className="w-4 h-4 accent-rose-600 rounded cursor-pointer"
                        />
                        <div className="flex-1 flex items-center justify-between min-w-0">
                          <span className="font-mono font-medium text-slate-800">
                            {r.OrderNumber || (r.__rowId ?? r.id)}
                          </span>
                          <span className="text-[11px] text-slate-500">
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
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 space-y-1.5">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>Permanent Action Warning</span>
                </div>
                <p className="text-[11px] text-rose-800 leading-relaxed">
                  This removes <strong>{dataset.name}</strong> from the dataset list, analytics, and RAG chat. Saved version files remain on disk for recovery.
                </p>
              </div>

              <div>
                <label className="block text-slate-700 font-medium mb-1.5">
                  Type <span className="font-mono font-bold text-slate-900 bg-slate-100 px-1 py-0.5 rounded">{dataset.name}</span> to confirm:
                </label>
                <input
                  type="text"
                  value={typedConfirmation}
                  onChange={(e) => setTypedConfirmation(e.target.value)}
                  placeholder={dataset.name}
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 focus:border-rose-500 focus:ring-2 focus:ring-rose-500/20 text-xs font-mono"
                  autoFocus
                />
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-200 bg-[#F8FAFC] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="px-4 py-2 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold cursor-pointer"
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
            className="px-5 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-xs disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 cursor-pointer"
          >
            {isDeleting ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
            <span>
              {deleteMode === 'rows'
                ? `Delete ${selectedRowIds.size} Row(s)`
                : 'Confirm & Delete Entire Dataset'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};
