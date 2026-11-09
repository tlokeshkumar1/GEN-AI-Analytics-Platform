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
        // Coerce numbers for manual rows
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
    <div className={`bg-white rounded-2xl border border-[#E2E8F0] shadow-xs overflow-hidden flex flex-col ${className}`}>
      {/* Live Dataset Version & Sync Status Ribbon */}
      <div className="px-4 sm:px-5 py-3 bg-slate-50 border-b border-[#E2E8F0] flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-800">
            Appending to Version {dataset.currentVersion}
          </span>
          <span className="text-slate-400">·</span>
          <span className="text-slate-600">
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
      <div className="p-4 sm:p-5 border-b border-[#E2E8F0] bg-[#F8FAFC] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold text-sm text-[#0F172A]">
            Append Records to {dataset.name}
          </h3>
          <p className="text-xs text-[#64748B] mt-0.5">
            Add rows to existing schema without overwriting existing data.
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="p-1 rounded-xl bg-slate-200/80 flex items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setAppendMode('upload')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
              appendMode === 'upload'
                ? 'bg-white text-[#2563EB] shadow-2xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Upload File
          </button>
          <button
            type="button"
            onClick={() => setAppendMode('manual')}
            className={`px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
              appendMode === 'manual'
                ? 'bg-white text-[#2563EB] shadow-2xs font-semibold'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Manual Entry ({manualRows.length})
          </button>
        </div>
      </div>

      {/* Mode 1: File Upload */}
      {appendMode === 'upload' && (
        <div className="p-5 sm:p-6 space-y-5">
          {/* File Dropzone */}
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-[#CBD5E1] hover:border-[#2563EB] rounded-2xl p-8 sm:p-10 text-center cursor-pointer transition-all bg-[#F8FAFC] hover:bg-[#EFF6FF] flex flex-col items-center justify-center gap-2 group"
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
            <div className="w-12 h-12 rounded-xl bg-white border border-[#CBD5E1] group-hover:border-[#BFDBFE] text-[#2563EB] flex items-center justify-center shadow-2xs transition-transform group-hover:scale-105">
              <Upload className="w-6 h-6" />
            </div>
            <div className="font-semibold text-xs text-[#0F172A] mt-1">
              {selectedFile ? selectedFile.name : 'Click to select CSV or spreadsheet file'}
            </div>
            <p className="text-[11px] text-[#64748B]">
              File must match dataset schema ({dataset.columns.length} columns)
            </p>
          </div>

          {isValidating && <p role="status" className="text-sm text-slate-600">Validating file contents...</p>}
          {/* Validation Summary Box */}
          {validationResult && (
            <div className="rounded-xl border border-slate-200 bg-[#F8FAFC] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-[#0F172A]">
                  Schema Validation Summary
                </span>
                <span className="text-xs font-mono text-[#64748B]">
                  {validationResult.totalRows} row(s) analyzed
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center gap-2.5">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-emerald-900">
                      {validationResult.validRows.length} Valid Rows
                    </div>
                    <div className="text-[10px] text-emerald-700">Ready to append</div>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 flex items-center gap-2.5">
                  <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-rose-900">
                      {validationResult.invalidRows.length} Invalid Rows
                    </div>
                    <div className="text-[10px] text-rose-700">Must be corrected before appending</div>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 flex items-center gap-2.5">
                  <FileSpreadsheet className="w-5 h-5 text-blue-600 shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-blue-900">
                      {dataset.columns.length - validationResult.missingColumns.length} / {dataset.columns.length} Columns
                    </div>
                    <div className="text-[10px] text-blue-700">Schema alignment</div>
                  </div>
                </div>
              </div>

              {/* Missing Columns warning if any */}
              {validationResult.missingColumns.length > 0 && (
                <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>
                    Missing required columns: <strong>{validationResult.missingColumns.join(', ')}</strong>
                  </span>
                </div>
              )}

              {/* Preview of valid rows */}
              {validationResult.validRows.length > 0 && (
                <div className="space-y-1.5 pt-2">
                  <span className="text-[11px] font-semibold text-[#475569] uppercase tracking-wider">
                    Preview of rows to append (First 3)
                  </span>
                  <div className="overflow-x-auto rounded-lg border border-[#E2E8F0] bg-white">
                    <table className="w-full text-left text-xs font-body-sm">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                          {dataset.columns.slice(0, 6).map((c) => (
                            <th key={c.name} className="py-2 px-3 text-[10px] uppercase font-semibold">
                              {c.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {validationResult.validRows.slice(0, 3).map((r, idx) => (
                          <tr key={idx}>
                            {dataset.columns.slice(0, 6).map((c) => (
                              <td key={c.name} className="py-1.5 px-3 whitespace-nowrap">
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
          <div className="flex justify-end pt-2">
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
              className="h-10 px-6 rounded-xl bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition-colors flex items-center gap-2 text-xs font-semibold shadow-xs disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSubmitting ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              <span>
                {isSubmitting
                  ? 'Appending records...'
                  : `Confirm & Append ${validationResult?.validRows.length ?? 0} Rows`}
              </span>
            </button>
          </div>
        </div>
      )}

      {/* Mode 2: Manual Row Entry */}
      {appendMode === 'manual' && (
        <div className="p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#64748B]">
              Add custom row items manually to match the current dataset schema.
            </span>
            <button
              type="button"
              onClick={handleAddManualRow}
              className="h-8 px-3 rounded-lg bg-[#EFF6FF] text-[#1D4ED8] hover:bg-[#DBEAFE] transition-colors flex items-center gap-1.5 text-xs font-semibold cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Another Row</span>
            </button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-[#E2E8F0] bg-white">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                  <th className="py-2 px-3 w-10 text-center text-[10px]">#</th>
                  {dataset.columns.map((c) => (
                    <th key={c.name} className="py-2 px-2.5 text-[10px] uppercase font-semibold whitespace-nowrap">
                      {c.name}
                    </th>
                  ))}
                  <th className="py-2 px-2 w-10 text-center">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {manualRows.map((row, idx) => (
                  <tr key={(row.__rowId ?? row.id)}>
                    <td className="py-2 px-3 text-center text-slate-400 font-mono text-[10px]">
                      {idx + 1}
                    </td>
                    {dataset.columns.map((col) => (
                      <td key={col.name} className="py-1.5 px-2">
                        <input
                          type={col.type === 'number' || col.type === 'percentage' ? 'number' : col.type === 'date' ? 'date' : 'text'}
                          value={row[col.name] ?? ''}
                          onChange={(e) => handleManualCellChange((row.__rowId ?? row.id), col.name, e.target.value)}
                          className="w-full px-2 py-1 text-xs rounded border border-slate-200 focus:border-[#2563EB] focus:outline-none"
                        />
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-center">
                      <button
                        type="button"
                        onClick={() => handleRemoveManualRow((row.__rowId ?? row.id))}
                        className="text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
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
          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={handleSubmitAppend}
              disabled={manualRows.length === 0 || isSubmitting}
              className="h-10 px-6 rounded-xl bg-[#2563EB] text-white hover:bg-[#1D4ED8] transition-colors flex items-center gap-2 text-xs font-semibold shadow-xs disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSubmitting ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              <span>
                {isSubmitting
                  ? 'Appending records...'
                  : `Confirm & Append ${manualRows.length} Manual Row(s)`}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
