import React, { useState, useRef } from 'react';
import {
  Upload,
  FileSpreadsheet,
  CheckCircle2,
  AlertCircle,
  Plus,
  Trash2,
  RefreshCw,
  Layers,
  ArrowRight,
  Info,
} from 'lucide-react';
import { DatasetItem, DatasetRow, AppendValidationResult } from '../../types/dataset';
import { appendDatasetData, previewAppendFile } from '../../services/datasetService';
import { getApiErrorMessage } from '../../services/api';
import { DatasetStatusBadge } from './DatasetStatusBadge';

interface DatasetAppendViewProps {
  dataset: DatasetItem;
  onAppended: (updatedDataset?: DatasetItem) => void;
  onToast: (msg: string) => void;
  className?: string;
}

export const DatasetAppendView: React.FC<DatasetAppendViewProps> = ({
  dataset,
  onAppended,
  onToast,
  className = '',
}) => {
  const [appendMode, setAppendMode] = useState<'upload' | 'manual'>('upload');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const blankRow = (): DatasetRow => {
    const rowId = crypto.randomUUID();
    return {
      ...Object.fromEntries(dataset.columns.map(c => [c.name, ''])),
      id: dataset.columns.some(c => c.name === 'id') ? '' : rowId,
      __rowId: rowId,
    };
  };
  const [manualRows, setManualRows] = useState<DatasetRow[]>([blankRow()]);
  const [isValidating, setIsValidating] = useState(false);

  const [validationResult, setValidationResult] = useState<AppendValidationResult | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (file: File) => {
    setSelectedFile(file);
    setValidationResult(null);
    setIsValidating(true);
    try {
      setValidationResult(await previewAppendFile(dataset.id, file));
    } catch (err) {
      setSelectedFile(null);
      onToast(getApiErrorMessage(err, 'Could not validate append file.'));
    } finally { setIsValidating(false); }
  };

  const handleAddManualRow = () => {
    setManualRows(prev => [...prev, blankRow()]);
  };

  const handleRemoveManualRow = (id: string) => {
    setManualRows((prev) => prev.filter((r) => (r.__rowId ?? r.id) !== id));
  };

  const handleManualCellChange = (id: string, colName: string, value: any) => {
    setManualRows((prev) =>
      prev.map((r) => ((r.__rowId ?? r.id) === id ? { ...r, [colName]: value } : r))
    );
  };

  const handleSubmitAppend = async () => {
    setIsSubmitting(true);
    try {
      let updatedDataset: DatasetItem | undefined;
      if (appendMode === 'upload') {
        if (!validationResult || validationResult.validRows.length === 0) {
          onToast('No valid rows available to append.');
          return;
        }
        if (validationResult.invalidRows.length || validationResult.missingColumns.length || validationResult.extraColumns.length) {
          onToast('Correct the schema and invalid rows before appending.');
          return;
        }
        const res = await appendDatasetData(dataset.id, {
          rows: validationResult.validRows,
          file: selectedFile || undefined,
        });
        onToast(res.message);
        updatedDataset = res.dataset;
        setSelectedFile(null);
        setValidationResult(null);
      } else {
        if (manualRows.length === 0) {
          onToast('No manual rows to append.');
          return;
        }

        const coerced = manualRows.map((r) => {
          const item = { ...r };
          dataset.columns.forEach((col) => {
            if ((col.type === 'number' || col.type === 'percentage') && item[col.name] !== undefined) {
              item[col.name] = item[col.name] === '' ? null : String(item[col.name]);
            }
          });
          return item;
        });

        const res = await appendDatasetData(dataset.id, { rows: coerced });
        onToast(res.message);
        updatedDataset = res.dataset;
        setManualRows([]);
      }
      onAppended(updatedDataset);
    } catch (err: any) {
      onToast(getApiErrorMessage(err, 'Append failed.'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={`bg-[var(--color-background-surface)] rounded-[var(--radius-container)] border border-[var(--color-border)] shadow-[var(--shadow-xs)] overflow-hidden flex flex-col ${className}`}>
      {/* Live Dataset Version & Sync Status Ribbon */}
      <div className="px-4 sm:px-5 py-2.5 bg-[var(--color-background-subtle)] border-b border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-[var(--color-text-primary)]">
            Appending to Version {dataset.currentVersion}
          </span>
          <span className="text-[var(--color-text-muted)]">·</span>
          <span className="text-[var(--color-text-secondary)]">
            {dataset.name} ({dataset.rowCount.toLocaleString()} current rows)
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

      {/* Mode Switcher Header */}
      <div className="p-3 sm:p-4 border-b border-[var(--color-border)] bg-[var(--color-background-surface)] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-xs text-[var(--color-text-primary)]">
            Append Records to {dataset.name}
          </h3>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
            Add rows to existing schema without overwriting existing data.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="p-1 rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)] flex items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setAppendMode('upload')}
            className={`px-3 py-1 rounded-[var(--radius-inner)] font-medium transition-all cursor-pointer text-xs ${
              appendMode === 'upload'
                ? 'bg-[var(--color-background-surface)] text-[var(--color-primary)] shadow-[var(--shadow-xs)] font-semibold'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            Upload File
          </button>
          <button
            type="button"
            onClick={() => setAppendMode('manual')}
            className={`px-3 py-1 rounded-[var(--radius-inner)] font-medium transition-all cursor-pointer text-xs ${
              appendMode === 'manual'
                ? 'bg-[var(--color-background-surface)] text-[var(--color-primary)] shadow-[var(--shadow-xs)] font-semibold'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            Manual Entry ({manualRows.length})
          </button>
        </div>
      </div>

      {/* Mode 1: File Upload */}
      {appendMode === 'upload' && (
        <div className="p-4 sm:p-5 space-y-4">
          {/* File Dropzone */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border border-dashed border-[var(--color-border)] hover:border-[var(--color-primary)] rounded-[var(--radius-container)] p-6 sm:p-8 text-center cursor-pointer transition-all bg-[var(--color-background-subtle)] hover:bg-[var(--color-primary-soft)]/30 flex flex-col items-center justify-center gap-2 group"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  handleFileSelect(e.target.files[0]);
                }
              }}
            />
            <div className="w-10 h-10 rounded-[var(--radius-element)] bg-[var(--color-background-surface)] border border-[var(--color-border)] group-hover:border-[var(--color-primary-muted)] text-[var(--color-primary)] flex items-center justify-center shadow-[var(--shadow-xs)] transition-transform">
              <Upload className="w-5 h-5" />
            </div>
            <div className="font-medium text-xs text-[var(--color-text-primary)] mt-1">
              {selectedFile ? selectedFile.name : 'Click to select CSV or spreadsheet file'}
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)]">
              File must match dataset schema ({dataset.columns.length} columns)
            </p>
          </div>

          {isValidating && <p role="status" className="text-xs text-[var(--color-text-muted)]">Validating file contents…</p>}

          {/* Validation Summary Box */}
          {validationResult && (
            <div className="rounded-[var(--radius-container)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-primary)]">
                  Schema Validation Summary
                </span>
                <span className="text-[11px] font-mono text-[var(--color-text-muted)]">
                  {validationResult.totalRows} row(s) analyzed
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-success-soft)] border border-[var(--color-success-muted)] flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-[var(--color-success)] shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-[var(--color-success)]">
                      {validationResult.validRows.length} Valid Rows
                    </div>
                    <div className="text-[10px] text-[var(--color-text-muted)]">Ready to append</div>
                  </div>
                </div>

                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-error-soft)] border border-[var(--color-error-muted)] flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-[var(--color-error)] shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-[var(--color-error)]">
                      {validationResult.invalidRows.length} Invalid Rows
                    </div>
                    <div className="text-[10px] text-[var(--color-text-muted)]">Must be corrected</div>
                  </div>
                </div>

                <div className="p-2.5 rounded-[var(--radius-element)] bg-[var(--color-primary-soft)] border border-[var(--color-primary-muted)] flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
                  <div>
                    <div className="text-xs font-semibold text-[var(--color-primary)]">
                      {dataset.columns.length - validationResult.missingColumns.length} / {dataset.columns.length} Columns
                    </div>
                    <div className="text-[10px] text-[var(--color-text-muted)]">Schema alignment</div>
                  </div>
                </div>
              </div>

              {/* Missing Columns warning if any */}
              {validationResult.missingColumns.length > 0 && (
                <div className="p-2 rounded-[var(--radius-element)] bg-[var(--color-error-soft)] border border-[var(--color-error-muted)] text-xs text-[var(--color-error)] flex items-center gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-[var(--color-error)] shrink-0" />
                  <span>
                    Missing required columns: <strong>{validationResult.missingColumns.join(', ')}</strong>
                  </span>
                </div>
              )}

              {/* Preview of valid rows */}
              {validationResult.validRows.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  <span className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
                    Preview of rows to append (First 3)
                  </span>
                  <div className="overflow-x-auto rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)]">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="bg-[var(--color-background-subtle)] border-b border-[var(--color-border)] text-[var(--color-text-secondary)]">
                          {dataset.columns.slice(0, 6).map((c) => (
                            <th key={c.name} className="py-2 px-3 text-[10px] uppercase font-medium">
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--color-border)]">
                        {validationResult.validRows.slice(0, 3).map((r, idx) => (
                          <tr key={idx}>
                            {dataset.columns.slice(0, 6).map((c) => (
                              <td key={c.name} className="py-1.5 px-3 whitespace-nowrap text-[var(--color-text-primary)]">
                                {String(r[c.name] ?? '')}
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

          {/* Submit Action */}
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={handleSubmitAppend}
              disabled={
                !validationResult ||
                validationResult.validRows.length === 0 ||
                isSubmitting || isValidating ||
                validationResult.invalidRows.length > 0 ||
                validationResult.missingColumns.length > 0 ||
                validationResult.extraColumns.length > 0
              }
              className="h-8 px-4 rounded-[var(--radius-element)] bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors flex items-center gap-2 text-xs font-medium shadow-[var(--shadow-xs)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSubmitting ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              <span>
                {isSubmitting
                  ? 'Appending records…'
                  : `Confirm & Append ${validationResult?.validRows.length ?? 0} Rows`}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Mode 2: Manual Row Entry */}
      {appendMode === 'manual' && (
        <div className="p-4 sm:p-5 space-y-3.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--color-text-muted)]">
              Add custom row items manually to match the current dataset schema.
            </span>
            <button
              type="button"
              onClick={handleAddManualRow}
              className="h-7 px-2.5 rounded-[var(--radius-element)] bg-[var(--color-primary-soft)] text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)] transition-colors flex items-center gap-1 text-xs font-medium cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Row</span>
            </button>
          </div>

          <div className="overflow-x-auto rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)]">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-[var(--color-background-subtle)] border-b border-[var(--color-border)] text-[var(--color-text-secondary)]">
                  <th className="py-2 px-3 w-10 text-center text-[10px]">#</th>
                  {dataset.columns.map((c) => (
                    <th key={c.name} className="py-2 px-2.5 text-[10px] uppercase font-medium whitespace-nowrap">
                      {c.name}
                    </th>
                  ))}
                  <th className="py-2 px-2 w-10 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {manualRows.map((row, idx) => (
                  <tr key={(row.__rowId ?? row.id)}>
                    <td className="py-1.5 px-3 text-center text-[var(--color-text-muted)] font-mono text-[10px]">
                      {idx + 1}
                    </td>
                    {dataset.columns.map((col) => (
                      <td key={col.name} className="py-1 px-2">
                        <input
                          type={col.type === 'number' || col.type === 'percentage' ? 'number' : col.type === 'date' ? 'date' : 'text'}
                          value={row[col.name] ?? ''}
                          onChange={(e) => handleManualCellChange((row.__rowId ?? row.id), col.name, e.target.value)}
                          className="w-full px-2 py-1 text-xs rounded-[var(--radius-inner)] border border-[var(--color-border)] focus:border-[var(--color-primary)] focus:outline-none"
                        />
                      </td>
                    ))}
                    <td className="py-1 px-2 text-center">
                      <button
                        type="button"
                        onClick={() => handleRemoveManualRow((row.__rowId ?? row.id))}
                        className="text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors cursor-pointer"
                        title="Remove row"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Submit Action */}
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={handleSubmitAppend}
              disabled={manualRows.length === 0 || isSubmitting}
              className="h-8 px-4 rounded-[var(--radius-element)] bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] transition-colors flex items-center gap-2 text-xs font-medium shadow-[var(--shadow-xs)] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSubmitting ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5" />
              )}
              <span>
                {isSubmitting
                  ? 'Appending records…'
                  : `Confirm & Append ${manualRows.length} Manual Row(s)`}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
