import React, { useEffect, useState } from 'react';
import api, { getApiErrorMessage } from '../../services/api';
import { uploadDatasetFileStream, UploadResponse, UploadStageEvent, getDatabaseTables, CloudTableInfo } from '../../services/uploadService';

export function FileImportReview({
  file,
  onSaved,
  onCancel,
  onCommitStart,
  onCommitProgress,
  onCommitError,
}: {
  file: File;
  onSaved: (result: UploadResponse) => void;
  onCancel: () => void;
  onCommitStart?: (filename: string) => void;
  onCommitProgress?: (event: UploadStageEvent) => void;
  onCommitError?: (error: string) => void;
}) {
  const [sheets, setSheets] = useState<{ name: string; tables: { name: string }[]; suggested_header_row?: number }[]>([]);
  const [options, setOptions] = useState<Record<string, any>>({ header_row: 1, duplicate_policy: 'keep', decimal_separator: '.', column_types: {} });
  const [profile, setProfile] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [operations, setOperations] = useState('[]');
  const [mappings, setMappings] = useState({ units: '{}', currencies: '{}' });

  // SAP HANA Cloud Table Destination States
  const [cloudTables, setCloudTables] = useState<CloudTableInfo[]>([]);
  const [tableDestMode, setTableDestMode] = useState<'new' | 'existing' | 'none'>('new');
  const deriveDefaultTableName = (sheetName?: string | null) => {
    const fileBase = file.name
      .replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '');
    const cleanSheet = sheetName
      ? sheetName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
      : '';
    const combined = cleanSheet && !fileBase.toUpperCase().endsWith(cleanSheet.toUpperCase())
      ? `${fileBase}_${cleanSheet}`
      : fileBase;
    return combined.toUpperCase() || 'UPLOADED_TABLE';
  };
  const defaultTableName = deriveDefaultTableName(options.sheet);
  const [newTableName, setNewTableName] = useState<string>(() => deriveDefaultTableName());
  const [tableUserEdited, setTableUserEdited] = useState(false);
  const [existingTableName, setExistingTableName] = useState<string>('');
  const [existingTableAction, setExistingTableAction] = useState<'append' | 'replace'>('append');

  const buildPlan = () => {
    const parsing = { ...options };
    for (const key of ['units', 'currencies'] as const) {
      const value = JSON.parse(mappings[key]);
      if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`Enter a JSON object for ${key}.`);
      parsing[key] = value;
    }
    return { parsing, operations: JSON.parse(operations) };
  };

  useEffect(() => {
    let cancelled = false;
    const form = new FormData(); form.append('file', file);
    api.post('/upload/discover', form, { headers: { 'Content-Type': 'multipart/form-data' } })
      .then(({ data }) => {
        if (!cancelled) {
          setSheets(data.sheets || []);
          const firstSheet = data.sheets?.[0];
          const suggested = data.suggested_header_row ?? firstSheet?.suggested_header_row;
          if (!tableUserEdited && firstSheet?.name) {
            setNewTableName(deriveDefaultTableName(firstSheet.name));
          }
          setOptions(previous => ({
            ...previous,
            sheet: data.sheets?.length === 1 ? firstSheet.name : previous.sheet,
            header_row: typeof suggested === 'number' && suggested >= 1 ? suggested : previous.header_row,
          }));
        }
      })
      .catch(err => { if (!cancelled) setError(getApiErrorMessage(err, 'Source discovery failed.')); });

    // Load available SAP HANA Cloud tables
    getDatabaseTables()
      .then(res => {
        if (!cancelled && res.tables) {
          setCloudTables(res.tables);
          if (res.tables.length > 0) {
            setExistingTableName(res.tables[0].name);
          }
        }
      })
      .catch(err => {
        console.warn('Could not retrieve HANA tables:', err);
      });

    return () => { cancelled = true; };
  }, [file]);

  const change = (value: Record<string, any>) => { setOptions(previous => ({ ...previous, ...value })); setProfile(null); };

  const preview = async () => {
    setBusy(true); setError('');
    try {
      const form = new FormData(); form.append('file', file); form.append('plan', JSON.stringify(buildPlan()));
      setProfile((await api.post('/upload/preview', form, { headers: { 'Content-Type': 'multipart/form-data' } })).data);
    } catch (err) { setError(getApiErrorMessage(err, 'Import preview failed.')); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true); setError('');
    if (onCommitStart) {
      onCommitStart(file.name);
    }
    try {
      let targetTable: string | undefined = undefined;
      let targetAction: 'create' | 'append' | 'replace' | 'none' = 'none';

      if (tableDestMode === 'new') {
        targetTable = newTableName.trim() || defaultTableName;
        targetAction = 'create';
      } else if (tableDestMode === 'existing' && existingTableName) {
        targetTable = existingTableName;
        targetAction = existingTableAction;
      }

      const res = await uploadDatasetFileStream(
        file,
        buildPlan(),
        targetTable,
        targetAction,
        (event) => {
          if (onCommitProgress) {
            onCommitProgress(event);
          }
        }
      );
      onSaved(res);
    } catch (err) {
      const errMsg = getApiErrorMessage(err, 'Import failed.');
      setError(errMsg);
      if (onCommitError) {
        onCommitError(errMsg);
      }
    }
    finally { setBusy(false); }
  };

  const inputClass = 'h-8 px-2.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] text-[var(--color-text-primary)] text-xs w-full focus:border-[var(--color-primary)] focus:outline-none';
  const effectiveTableName = tableDestMode === 'new' ? (newTableName.trim() || defaultTableName) : tableDestMode === 'existing' ? existingTableName : '';

  return (
    <section className="bg-[var(--color-background-surface)] rounded-[var(--radius-container)] border border-[var(--color-border)] p-4 sm:p-5 space-y-4 shadow-[var(--shadow-xs)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-sm text-[var(--color-text-primary)]">Review import: {file.name}</h2>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">The original source is preserved. Preview these settings before saving a version.</p>
        </div>
        <span className="text-[11px] bg-[var(--color-primary-soft)] text-[var(--color-primary)] px-2.5 py-0.5 rounded-[var(--radius-full)] font-medium border border-[var(--color-primary-muted)]">
          AI RAG Vector Store + Direct Relational Cloud Storage
        </span>
      </div>

      {error && (
        <p role="alert" className="text-[var(--color-error)] bg-[var(--color-error-soft)] border border-[var(--color-error-muted)] p-2.5 rounded-[var(--radius-element)] text-xs font-medium">
          {error}
        </p>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
        {!!sheets.length && (
          <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
            <span>Worksheet</span>
            <select className={inputClass} value={options.sheet || ''} onChange={e => {
              const nextSheetName = e.target.value || null;
              const sheetInfo = sheets.find(s => s.name === nextSheetName) || sheets[0];
              if (!tableUserEdited && nextSheetName) {
                setNewTableName(deriveDefaultTableName(nextSheetName));
              }
              change({
                sheet: nextSheetName,
                table: null,
                ...(typeof sheetInfo?.suggested_header_row === 'number' ? { header_row: sheetInfo.suggested_header_row } : {}),
              });
            }}>
              <option value="">{sheets.length === 1 ? sheets[0].name : 'Choose a sheet'}</option>
              {sheets.map(sheet => <option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}
            </select>
          </label>
        )}
        {!!sheets.find(s => s.name === (options.sheet || sheets[0]?.name))?.tables.length && (
          <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
            <span>Table</span>
            <select className={inputClass} value={options.table || ''} onChange={e => change({ table: e.target.value || null })}>
              <option value="">Select a table or use the sheet</option>
              {sheets.find(s => s.name === (options.sheet || sheets[0]?.name))?.tables.map(table => <option key={table.name}>{table.name}</option>)}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
          <span>Header row</span>
          <input type="number" min={1} className={inputClass} value={options.header_row} onChange={e => change({ header_row: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
          <span>Duplicate policy</span>
          <select className={inputClass} value={options.duplicate_policy} onChange={e => change({ duplicate_policy: e.target.value })}>
            <option value="keep">Keep repeated transactions</option>
            <option value="reject">Require review if duplicates exist</option>
            <option value="drop">Remove exact duplicate rows</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
          <span>Decimal separator</span>
          <select className={inputClass} value={options.decimal_separator} onChange={e => change({ decimal_separator: e.target.value })}>
            <option>.</option>
            <option>,</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
          <span>Thousands separator</span>
          <select className={inputClass} value={options.thousands_separator || ''} onChange={e => change({ thousands_separator: e.target.value || null })}>
            <option value="">None</option>
            <option>,</option>
            <option>.</option>
            <option value=" ">Space</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
          <span>Date format</span>
          <input placeholder="e.g. %d/%m/%Y" className={inputClass} value={options.date_format || ''} onChange={e => change({ date_format: e.target.value || null })} />
        </label>
        <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
          <span>Time zone</span>
          <input placeholder="e.g. Asia/Kolkata" className={inputClass} value={options.timezone || ''} onChange={e => change({ timezone: e.target.value || null })} />
        </label>
        {file.name.toLowerCase().endsWith('.csv') && (
          <label className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)]">
            <span>CSV delimiter</span>
            <input maxLength={1} className={inputClass} value={options.delimiter || ','} onChange={e => change({ delimiter: e.target.value })} />
          </label>
        )}
      </div>

      {/* SAP HANA Cloud Table Destination Configuration */}
      <div className="rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[var(--color-primary)] text-[18px]">cloud_upload</span>
            <h3 className="font-semibold text-[var(--color-text-primary)] text-xs">SAP HANA Cloud Table Destination</h3>
          </div>
          <span className="text-[10px] bg-[var(--color-background-surface)] text-[var(--color-text-secondary)] border border-[var(--color-border)] px-2 py-0.5 rounded-[var(--radius-full)] font-medium">
            Direct SQL Table Access
          </span>
        </div>
        <p className="text-[11px] text-[var(--color-text-muted)]">
          Choose which relational table in SAP HANA Cloud this tabular data must be stored in so you can access it directly with SQL.
        </p>

        <div className="flex flex-wrap gap-4 text-xs font-medium text-[var(--color-text-secondary)] pt-1">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="tableDestMode"
              value="new"
              checked={tableDestMode === 'new'}
              onChange={() => setTableDestMode('new')}
              className="text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
            />
            <span>Create New Table in Cloud</span>
          </label>
          {cloudTables.length > 0 && (
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="tableDestMode"
                value="existing"
                checked={tableDestMode === 'existing'}
                onChange={() => setTableDestMode('existing')}
                className="text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
              />
              <span>Insert into Existing Table ({cloudTables.length} available)</span>
            </label>
          )}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="radio"
              name="tableDestMode"
              value="none"
              checked={tableDestMode === 'none'}
              onChange={() => setTableDestMode('none')}
              className="text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
            />
            <span>Vector &amp; File Store Only</span>
          </label>
        </div>

        {tableDestMode === 'new' && (
          <div className="grid sm:grid-cols-2 gap-3 pt-1">
            <label className="text-xs font-medium text-[var(--color-text-secondary)] flex flex-col gap-1">
              <span>HANA Table Name</span>
              <input
                type="text"
                className={`${inputClass} font-mono uppercase text-xs`}
                placeholder="e.g. ENTERPRISE_DATASET_V1"
                value={newTableName}
                onChange={e => {
                  setNewTableName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'));
                  setTableUserEdited(true);
                }}
              />
            </label>
            <div className="flex items-center text-[11px] text-[var(--color-text-muted)] pt-4">
              Will automatically create a typed <strong className="font-semibold text-[var(--color-text-primary)] ml-1">COLUMN TABLE</strong> in SAP HANA Cloud.
            </div>
          </div>
        )}

        {tableDestMode === 'existing' && (
          <div className="grid sm:grid-cols-2 gap-3 pt-1">
            <label className="text-xs font-medium text-[var(--color-text-secondary)] flex flex-col gap-1">
              <span>Choose Existing HANA Table</span>
              <select
                className={`${inputClass} text-xs font-mono`}
                value={existingTableName}
                onChange={e => setExistingTableName(e.target.value)}
              >
                {cloudTables.map(t => (
                  <option key={t.name} value={t.name}>
                    {t.name} ({t.rowCount.toLocaleString()} rows, {t.columnCount} columns)
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-[var(--color-text-secondary)] flex flex-col gap-1">
              <span>Operation Action</span>
              <select
                className={`${inputClass} text-xs`}
                value={existingTableAction}
                onChange={e => setExistingTableAction(e.target.value as 'append' | 'replace')}
              >
                <option value="append">Append (Add new rows to existing table)</option>
                <option value="replace">Replace (Delete existing data and reload)</option>
              </select>
            </label>
          </div>
        )}
      </div>

      <details className="border border-[var(--color-border)] rounded-[var(--radius-element)] p-3">
        <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-primary)] select-none">
          Units, currencies and transformations
        </summary>
        <p className="text-[11px] text-[var(--color-text-muted)] my-2">Map source field names to units or ISO currencies. Transformations support trim, rename and fill_missing.</p>
        {(['units', 'currencies'] as const).map(key => (
          <label className="block text-xs my-2 font-medium text-[var(--color-text-secondary)]" key={key}>
            <span className="capitalize">{key}</span>
            <input
              aria-label={`${key} mapping`}
              className={`${inputClass} mt-1`}
              placeholder='{"Amount":"USD"}'
              value={mappings[key]}
              onChange={e => {
                setProfile(null);
                setMappings(previous => ({ ...previous, [key]: e.target.value }));
              }}
            />
          </label>
        ))}
        <label className="block text-xs font-medium text-[var(--color-text-secondary)]">
          <span>Transformations JSON</span>
          <textarea
            aria-label="Transformations JSON"
            className="w-full mt-1 p-2 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] font-mono text-xs focus:border-[var(--color-primary)] focus:outline-none"
            rows={3}
            value={operations}
            onChange={e => { setOperations(e.target.value); setProfile(null); }}
          />
        </label>
      </details>

      {profile && (
        <div className="space-y-2 pt-1">
          <p className="text-xs font-medium text-[var(--color-text-primary)]">
            {profile.profile.row_count.toLocaleString()} rows · {profile.profile.duplicate_count} matching rows · {profile.profile.fields.length} fields
          </p>
          {profile.profile.warnings.map((warning: string) => (
            <p key={warning} className="text-[var(--color-warning)] text-xs">{warning}</p>
          ))}
          <div className="overflow-auto max-h-72 border border-[var(--color-border)] rounded-[var(--radius-element)]">
            <table className="w-full text-xs text-left border-collapse">
              <thead className="bg-[var(--color-background-subtle)] border-b border-[var(--color-border)] sticky top-0 text-[var(--color-text-secondary)]">
                <tr>
                  <th className="p-2 font-medium">Field</th>
                  <th className="font-medium">Type</th>
                  <th className="font-medium">Missing</th>
                  <th className="font-medium">Distinct</th>
                  <th className="p-2 font-medium">Examples / warnings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {profile.profile.fields.map((field: any) => (
                  <tr key={field.name} className="hover:bg-[var(--color-background-subtle)]">
                    <td className="p-2 font-mono text-xs">{field.name}</td>
                    <td>
                      <select
                        aria-label={`${field.name} source type`}
                        className="border border-[var(--color-border)] rounded-[var(--radius-inner)] p-1 text-xs bg-[var(--color-background-surface)]"
                        value={field.type}
                        onChange={e => change({ column_types: { ...options.column_types, [field.name]: e.target.value } })}
                      >
                        {['string', 'identifier', 'integer', 'decimal', 'boolean', 'date'].map(type => (
                          <option key={type}>{type}</option>
                        ))}
                      </select>
                    </td>
                    <td>{field.missing_count}</td>
                    <td>{field.distinct_count}</td>
                    <td className="p-2 text-[11px] text-[var(--color-text-muted)]">
                      {field.samples.map((v: unknown) => v == null ? 'missing' : String(v)).join(', ')}
                      {field.warnings.length > 0 && <p className="text-[var(--color-warning)]">{field.warnings.join(' ')}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--color-border)]">
        <button
          disabled={busy}
          className="border border-[var(--color-border)] bg-[var(--color-background-surface)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-primary)] rounded-[var(--radius-element)] px-3.5 py-1.5 text-xs font-medium cursor-pointer transition-colors"
          onClick={() => void preview()}
        >
          {busy ? 'Validating…' : 'Preview and validate'}
        </button>
        <button
          disabled={busy || !profile}
          className="bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white rounded-[var(--radius-element)] px-4 py-1.5 text-xs font-medium disabled:opacity-40 shadow-[var(--shadow-xs)] cursor-pointer transition-colors"
          onClick={() => void commit()}
        >
          {busy ? 'Processing…' : (tableDestMode !== 'none' && effectiveTableName ? `Save Version & Store into '${effectiveTableName}'` : 'Save dataset version')}
        </button>
        <button
          disabled={busy}
          className="border border-[var(--color-border)] bg-[var(--color-background-surface)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-secondary)] rounded-[var(--radius-element)] px-3.5 py-1.5 text-xs font-medium cursor-pointer transition-colors"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
