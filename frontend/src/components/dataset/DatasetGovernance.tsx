import React, { useState } from 'react';
import api, { getApiErrorMessage } from '../../services/api';
import { DatasetItem } from '../../types/dataset';

export function DatasetGovernance({ dataset }: { dataset: DatasetItem }) {
  const [from, setFrom] = useState('');
  const [keys, setKeys] = useState('');
  const [comparison, setComparison] = useState<any>(null);
  const [grants, setGrants] = useState<{ owner_id: string; readers: string[]; writers: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); } catch (err) { setError(getApiErrorMessage(err, 'Dataset governance operation failed.')); }
    finally { setBusy(false); }
  };
  return <details className="bg-white border rounded-xl p-4 space-y-3"><summary className="cursor-pointer font-medium">Version comparison and access</summary>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <div className="flex gap-2 flex-wrap items-center text-sm">
      <label>Compare selected V{dataset.currentVersion} with <select aria-label="Compare version" className="border rounded p-2" value={from} onChange={e => setFrom(e.target.value)}><option value="">Choose version</option>{dataset.versions?.filter(v => v.version !== dataset.currentVersion).map(v => <option key={v.version} value={v.version}>V{v.version}</option>)}</select></label>
      <input aria-label="Comparison keys" className="border rounded p-2" placeholder="Stable keys, comma separated" value={keys} onChange={e => setKeys(e.target.value)} />
      <button disabled={busy || !from} className="border rounded px-3 py-2 disabled:opacity-40" onClick={() => void run(async () => setComparison((await api.get(`/datasets/${dataset.id}/compare`, { params: { from_version: from, to_version: dataset.currentVersion, keys } })).data))}>Compare</button>
    </div>
    {comparison && <div className="text-sm space-y-2"><p>{Object.entries(comparison.counts).map(([name, count]) => `${name}: ${count}`).join(' · ')}</p><p>Schema: {JSON.stringify(comparison.schema)}</p><p className="text-xs text-slate-500">{comparison.identity_note}</p></div>}
    <button disabled={busy} className="border rounded px-3 py-2 text-sm" onClick={() => void run(async () => setGrants((await api.get(`/datasets/${dataset.id}/access`)).data))}>Manage dataset access</button>
    {grants && <div className="grid gap-2 text-sm"><p>Owner: {grants.owner_id}</p>{(['readers', 'writers'] as const).map(role => <label key={role}>{role}<input className="w-full border rounded p-2" aria-label={`Dataset ${role}`} value={grants[role].join(', ')} onChange={e => setGrants({ ...grants, [role]: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })} /></label>)}
      <button disabled={busy} className="border rounded px-3 py-2 justify-self-start" onClick={() => void run(async () => setGrants((await api.put(`/datasets/${dataset.id}/access`, { readers: grants.readers, writers: grants.writers })).data))}>Save access grants</button>
    </div>}
  </details>;
}
