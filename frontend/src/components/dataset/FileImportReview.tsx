import React, { useEffect, useState } from 'react';
import api, { getApiErrorMessage } from '../../services/api';
import { uploadDatasetFile, UploadResponse, getDatabaseTables, CloudTableInfo } from '../../services/uploadService';

export function FileImportReview({
  file,
  onSaved,
  onCancel,
  onCommitStart,
  onCommitError,
}: {
  file: File;
  onSaved: (result: UploadResponse) => void;
  onCancel: () => void;
  onCommitStart?: (filename: string) => void;
  onCommitError?: (error: string) => void;
}) {
  const [sheets, setSheets] = useState<{ name: string; tables: { name: string }[] }[]>([]);
  const [options, setOptions] = useState<Record<string, any>>({ header_row: 1, duplicate_policy: 'keep', decimal_separator: '.', column_types: {} });
  const [profile, setProfile] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [operations, setOperations] = useState('[]');
  const [mappings, setMappings] = useState({ units: '{}', currencies: '{}' });

  // SAP HANA Cloud Table Destination States
  const [cloudTables, setCloudTables] = useState<CloudTableInfo[]>([]);
  const [tableDestMode, setTableDestMode] = useState<'new' | 'existing' | 'none'>('new');
  const defaultTableName = file.name
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase() || 'UPLOADED_TABLE';
  const [newTableName, setNewTableName] = useState<string>(defaultTableName);
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
      .then(({ data }) => { if (!cancelled) setSheets(data.sheets); })
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

      const res = await uploadDatasetFile(file, buildPlan(), targetTable, targetAction);
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

  const input = 'border border-slate-300 rounded-lg p-2 w-full';
  const effectiveTableName = tableDestMode === 'new' ? (newTableName.trim() || defaultTableName) : tableDestMode === 'existing' ? existingTableName : '';

  return <section className="bg-white rounded-2xl border border-blue-200 p-5 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h2 className="font-semibold text-lg text-slate-900">Review import: {file.name}</h2>
        <p className="text-sm text-slate-500">The original source is preserved. Preview these settings before saving a version.</p>
      </div>
      <span className="text-xs bg-blue-50 text-blue-700 px-3 py-1 rounded-full font-medium border border-blue-100">
        AI RAG Vector Store + Direct Relational Cloud Storage
      </span>
    </div>

    {error && <p role="alert" className="text-red-700 bg-red-50 p-3 rounded-lg text-sm">{error}</p>}

    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
      {!!sheets.length && <label>Worksheet<select className={input} value={options.sheet || ''} onChange={e => change({ sheet: e.target.value || null, table: null })}>
        <option value="">{sheets.length === 1 ? sheets[0].name : 'Choose a sheet'}</option>{sheets.map(sheet => <option key={sheet.name}>{sheet.name}</option>)}
      </select></label>}
      {!!sheets.find(s => s.name === (options.sheet || sheets[0]?.name))?.tables.length && <label>Table<select className={input} value={options.table || ''} onChange={e => change({ table: e.target.value || null })}>
        <option value="">Select a table or use the sheet</option>{sheets.find(s => s.name === (options.sheet || sheets[0]?.name))?.tables.map(table => <option key={table.name}>{table.name}</option>)}
      </select></label>}
      <label>Header row<input type="number" min={1} className={input} value={options.header_row} onChange={e => change({ header_row: Number(e.target.value) })} /></label>
      <label>Duplicate policy<select className={input} value={options.duplicate_policy} onChange={e => change({ duplicate_policy: e.target.value })}>
        <option value="keep">Keep repeated transactions</option><option value="reject">Require review if duplicates exist</option><option value="drop">Remove exact duplicate rows</option>
      </select></label>
      <label>Decimal separator<select className={input} value={options.decimal_separator} onChange={e => change({ decimal_separator: e.target.value })}><option>.</option><option>,</option></select></label>
      <label>Thousands separator<select className={input} value={options.thousands_separator || ''} onChange={e => change({ thousands_separator: e.target.value || null })}><option value="">None</option><option>,</option><option>.</option><option value=" ">Space</option></select></label>
      <label>Date format<input placeholder="e.g. %d/%m/%Y" className={input} value={options.date_format || ''} onChange={e => change({ date_format: e.target.value || null })} /></label>
      <label>Time zone<input placeholder="e.g. Asia/Kolkata" className={input} value={options.timezone || ''} onChange={e => change({ timezone: e.target.value || null })} /></label>
      {file.name.toLowerCase().endsWith('.csv') && <label>CSV delimiter<input maxLength={1} className={input} value={options.delimiter || ','} onChange={e => change({ delimiter: e.target.value })} /></label>}
    </div>

    {/* SAP HANA Cloud Relational Destination Table Configuration */}
    <div className="rounded-xl border border-blue-200 bg-gradient-to-r from-blue-50/70 to-indigo-50/50 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-blue-600 text-lg">cloud_upload</span>
          <h3 className="font-semibold text-slate-800 text-sm">SAP HANA Cloud Table Destination</h3>
        </div>
        <span className="text-xs bg-blue-100 text-blue-800 px-2.5 py-0.5 rounded-full font-medium">
          Direct SQL Table Access
        </span>
      </div>
      <p className="text-xs text-slate-600">
        Choose which relational table in SAP HANA Cloud this tabular data must be stored in so you can access it directly with SQL.
        Text chunking, 1536-dim vector embeddings in <code className="bg-white/80 px-1 py-0.5 rounded text-blue-700 font-mono">VECTOR_TABLE</code>, and version snapshots will also run in parallel.
      </p>

      <div className="flex flex-wrap gap-5 text-xs font-medium text-slate-700 pt-1">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name="tableDestMode"
            value="new"
            checked={tableDestMode === 'new'}
            onChange={() => setTableDestMode('new')}
            className="text-blue-600 focus:ring-blue-500"
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
              className="text-blue-600 focus:ring-blue-500"
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
            className="text-blue-600 focus:ring-blue-500"
          />
          <span>Vector & File Store Only (Skip dedicated table)</span>
        </label>
      </div>

      {tableDestMode === 'new' && (
        <div className="grid sm:grid-cols-2 gap-3 pt-2">
          <label className="text-xs font-medium text-slate-700">
            HANA Table Name
            <input
              type="text"
              className={`${input} font-mono uppercase text-xs mt-1 bg-white`}
              placeholder="e.g. SALES_DATA_2024"
              value={newTableName}
              onChange={e => setNewTableName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            />
          </label>
          <div className="flex items-center text-xs text-slate-600 pt-5">
            Will automatically create a typed <strong className="font-semibold text-slate-800 ml-1">COLUMN TABLE</strong> in SAP HANA Cloud.
          </div>
        </div>
      )}

      {tableDestMode === 'existing' && (
        <div className="grid sm:grid-cols-2 gap-3 pt-2">
          <label className="text-xs font-medium text-slate-700">
            Choose Existing HANA Table
            <select
              className={`${input} text-xs mt-1 bg-white font-mono`}
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
          <label className="text-xs font-medium text-slate-700">
            Operation Action
            <select
              className={`${input} text-xs mt-1 bg-white`}
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

    <details className="border rounded-lg p-3"><summary className="cursor-pointer text-sm font-medium text-slate-700">Units, currencies and transformations</summary>
      <p className="text-xs text-slate-500 my-2">Map source field names to units or ISO currencies. Transformations support trim, rename and fill_missing; preview shows their effects.</p>
      {(['units', 'currencies'] as const).map(key => <label className="block text-sm my-2" key={key}>{key}<input aria-label={`${key} mapping`} className={input} placeholder='{"Amount":"USD"}' value={mappings[key]} onChange={e => {
        setProfile(null); setMappings(previous => ({ ...previous, [key]: e.target.value }));
      }} /></label>)}
      <label className="block text-sm">Transformations JSON<textarea aria-label="Transformations JSON" className={`${input} font-mono text-xs`} rows={3} value={operations} onChange={e => { setOperations(e.target.value); setProfile(null); }} /></label>
    </details>

    {profile && <>
      <p className="text-sm font-medium text-slate-800">{profile.profile.row_count.toLocaleString()} rows · {profile.profile.duplicate_count} matching rows · {profile.profile.fields.length} fields</p>
      {profile.profile.warnings.map((warning: string) => <p key={warning} className="text-amber-800 text-sm">{warning}</p>)}
      <div className="overflow-auto max-h-72 border rounded-lg"><table className="w-full text-sm text-left">
        <thead className="bg-slate-50 sticky top-0"><tr><th className="p-2">Field</th><th>Type</th><th>Missing</th><th>Distinct</th><th className="p-2">Examples / warnings</th></tr></thead>
        <tbody>
          {profile.profile.fields.map((field: any) => <tr key={field.name} className="border-t"><td className="p-2 font-mono text-xs">{field.name}</td><td><select aria-label={`${field.name} source type`} className="border rounded p-1 text-xs" value={field.type} onChange={e => change({ column_types: { ...options.column_types, [field.name]: e.target.value } })}>
            {['string', 'identifier', 'integer', 'decimal', 'boolean', 'date'].map(type => <option key={type}>{type}</option>)}</select></td>
            <td>{field.missing_count}</td><td>{field.distinct_count}</td><td className="p-2 text-xs">{field.samples.map((v: unknown) => v == null ? 'missing' : String(v)).join(', ')}<p className="text-amber-800">{field.warnings.join(' ')}</p></td></tr>)}
        </tbody>
      </table></div>
    </>}

    <div className="flex flex-wrap items-center gap-2 pt-2">
      <button disabled={busy} className="border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg px-4 py-2 text-sm font-medium" onClick={() => void preview()}>
        {busy ? 'Validating...' : 'Preview and validate'}
      </button>
      <button disabled={busy || !profile} className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-5 py-2 text-sm font-medium disabled:opacity-40 shadow-sm" onClick={() => void commit()}>
        {busy ? 'Processing...' : (tableDestMode !== 'none' && effectiveTableName ? `Save Version & Store into HANA Table '${effectiveTableName}'` : 'Save dataset version')}
      </button>
      <button disabled={busy} className="border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg px-4 py-2 text-sm" onClick={onCancel}>
        Cancel
      </button>
    </div>
  </section>;
}
