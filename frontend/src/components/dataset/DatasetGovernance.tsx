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

  return (
    <details className="bg-[var(--color-background-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] p-4 space-y-3 shadow-[var(--shadow-xs)]">
      <summary className="cursor-pointer font-medium text-xs text-[var(--color-text-primary)] hover:text-[var(--color-primary)] transition-colors select-none">
        Version comparison & access governance
      </summary>
      {error && (
        <p role="alert" className="p-2 rounded-[var(--radius-element)] bg-[var(--color-error-soft)] text-[var(--color-error)] border border-[var(--color-error-muted)] text-xs font-medium">
          {error}
        </p>
      )}
      <div className="flex gap-2 flex-wrap items-center text-xs pt-1">
        <label className="flex items-center gap-1.5 text-[var(--color-text-secondary)] font-medium">
          <span>Compare V{dataset.currentVersion} with</span>
          <select
            aria-label="Compare version"
            className="h-8 px-2 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] text-[var(--color-text-primary)] cursor-pointer"
            value={from}
            onChange={e => setFrom(e.target.value)}
          >
            <option value="">Choose version</option>
            {dataset.versions?.filter(v => v.version !== dataset.currentVersion).map(v => (
              <option key={v.version} value={v.version}>V{v.version}</option>
            ))}
          </select>
        </label>
        <input
          aria-label="Comparison keys"
          className="h-8 px-2.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] text-[var(--color-text-primary)] placeholder-[var(--color-text-placeholder)] focus:border-[var(--color-primary)] focus:outline-none"
          placeholder="Stable keys, comma separated"
          value={keys}
          onChange={e => setKeys(e.target.value)}
        />
        <button
          disabled={busy || !from}
          className="h-8 px-3 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-surface)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-primary)] font-medium disabled:opacity-40 transition-colors cursor-pointer"
          onClick={() => void run(async () => setComparison((await api.get(`/datasets/${dataset.id}/compare`, { params: { from_version: from, to_version: dataset.currentVersion, keys } })).data))}
        >
          Compare
        </button>
      </div>

      {comparison && (
        <div className="text-xs space-y-1.5 p-3 rounded-[var(--radius-element)] bg-[var(--color-background-subtle)] border border-[var(--color-border)]">
          <p className="font-medium text-[var(--color-text-primary)]">
            {Object.entries(comparison.counts).map(([name, count]) => `${name}: ${count}`).join(' · ')}
          </p>
          <p className="font-mono text-[11px] text-[var(--color-text-muted)]">Schema: {JSON.stringify(comparison.schema)}</p>
          <p className="text-[11px] text-[var(--color-text-muted)]">{comparison.identity_note}</p>
        </div>
      )}

      <div className="pt-2 border-t border-[var(--color-border)]">
        <button
          disabled={busy}
          className="h-8 px-3 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-primary)] font-medium text-xs transition-colors cursor-pointer"
          onClick={() => void run(async () => setGrants((await api.get(`/datasets/${dataset.id}/access`)).data))}
        >
          Manage dataset access
        </button>
      </div>

      {grants && (
        <div className="grid gap-2 text-xs pt-1">
          <p className="text-[var(--color-text-muted)]">Owner: <span className="font-mono text-[var(--color-text-primary)]">{grants.owner_id}</span></p>
          {(['readers', 'writers'] as const).map(role => (
            <label key={role} className="flex flex-col gap-1 font-medium text-[var(--color-text-secondary)] capitalize">
              <span>{role}</span>
              <input
                className="h-8 px-2.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] text-[var(--color-text-primary)] focus:border-[var(--color-primary)] focus:outline-none"
                aria-label={`Dataset ${role}`}
                value={grants[role].join(', ')}
                onChange={e => setGrants({ ...grants, [role]: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })}
              />
            </label>
          ))}
          <button
            disabled={busy}
            className="h-8 px-3 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white font-medium text-xs justify-self-start transition-colors cursor-pointer shadow-[var(--shadow-xs)]"
            onClick={() => void run(async () => setGrants((await api.put(`/datasets/${dataset.id}/access`, { readers: grants.readers, writers: grants.writers })).data))}
          >
            Save access grants
          </button>
        </div>
      )}
    </details>
  );
}
