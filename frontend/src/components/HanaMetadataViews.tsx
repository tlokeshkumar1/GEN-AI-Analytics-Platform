import React, { useEffect, useState } from 'react';
import api, { getApiErrorMessage } from '../services/api';

type View = { name: string; label: string; description: string; rowCount: number; available: boolean };
type Page = { publicationCounts?: { all: number; published: number; unpublished: number }; totalRows: number; rows: { namespace: string; documentId: string; revision: number; published?: boolean; payload: string; truncated: boolean }[] };
function formatPayload(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
export function HanaMetadataViews() {
  const [views, setViews] = useState<View[]>([]);
  const [selected, setSelected] = useState('');
  const [page, setPage] = useState(1);
  const [publication, setPublication] = useState<'all' | 'published' | 'unpublished'>('all');
  const [data, setData] = useState<Page | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    api.get('/hanaadmin/views').then(response => {
      if (!active) return;
      setViews(response.data.views);
      setSelected(previous => previous || response.data.views.find((v: View) => v.available)?.name || '');
    }).catch(err => { if (active) setError(getApiErrorMessage(err, 'Unable to load metadata views.')); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    setLoadingRows(true); setData(null); setError('');
    api.get(`/hanaadmin/views/${selected}/data`, { params: { page, pageSize: 25, ...(selected === 'PM_ANALYTICS_V' ? { publication } : {}) } }).then(response => {
      if (active) setData(response.data);
    }).catch(err => { if (active) setError(getApiErrorMessage(err, 'Unable to load view records.')); })
      .finally(() => { if (active) setLoadingRows(false); });
    return () => { active = false; };
  }, [selected, page, refresh, publication]);
  return <section aria-label="Metadata category views" className="space-y-4">
    <div className="flex items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold">Metadata Categories</h2>
        <p className="text-xs text-[var(--color-text-secondary)]">Browse the eight read-only categories of PLATFORM_METADATA.</p></div>
      <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading || loadingRows}
        className="px-3 py-2 border rounded-[var(--radius-element)] text-xs cursor-pointer">Refresh Views</button>
    </div>
    {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    {loading && <p role="status" className="text-xs">Loading metadata categories...</p>}
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {views.map(view => <button key={view.name} type="button" disabled={!view.available} aria-pressed={selected === view.name}
        onClick={() => { setPage(1); setPublication('all'); setSelected(view.name); }}
        className={`p-4 text-left space-y-2 rounded-[var(--radius-container)] border bg-[var(--color-surface)] shadow-[var(--shadow-2xs)] cursor-pointer disabled:opacity-50 ${selected === view.name ? 'border-[var(--color-primary)] ring-1 ring-[var(--color-primary)]' : 'border-[var(--color-border)]'}`}>
        <span className="block text-xs font-semibold">{view.label}</span>
        <span className="block text-2xl font-semibold">{view.rowCount}</span>
        <span className="block text-[10px] break-all text-[var(--color-text-secondary)]">{view.name}</span>
        <span className="block text-xs text-[var(--color-text-secondary)]">{view.description}</span>
        <span className="block text-[10px]">{view.available ? 'Read-only view' : 'Not deployed'}</span>
      </button>)}
    </div>
    {selected && <div className="p-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] space-y-3">
      <h3 className="text-sm font-semibold">{views.find(v => v.name === selected)?.label} Records</h3>
      {selected === 'PM_ANALYTICS_V' && <div className="flex gap-2 flex-wrap" aria-label="Publication filters">
        {(['all', 'published', 'unpublished'] as const).map(filter => <button key={filter} type="button" aria-pressed={publication === filter}
          onClick={() => { setPage(1); setPublication(filter); }}
          className={`px-3 py-1.5 rounded-[var(--radius-element)] border text-xs cursor-pointer ${publication === filter ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-surface)]'}`}>
          {filter === 'all' ? 'All' : filter === 'published' ? 'Published' : 'Not Published'}{data?.publicationCounts ? ` (${data.publicationCounts[filter]})` : ''}
        </button>)}
      </div>}
      {loadingRows && <p role="status" className="text-xs">Loading records...</p>}
      {data && <>
        <p className="text-xs">{data.totalRows} records ? Read-only</p>
        {!data.rows.length && <p className="text-xs">No records in this category.</p>}
        <div className="overflow-x-auto"><table className="w-full text-left text-xs">
          <thead><tr><th className="p-2">Namespace</th><th className="p-2">Document ID</th><th className="p-2">Revision</th>{selected === 'PM_ANALYTICS_V' && <th className="p-2">Publication Status</th>}<th className="p-2">Stored Data</th></tr></thead>
          <tbody>{data.rows.map(row => <tr key={`${row.namespace}:${row.documentId}`} className="border-t border-[var(--color-border)] align-top">
            <td className="p-2 max-w-xs break-all">{row.namespace}</td><td className="p-2 max-w-xs break-all">{row.documentId}</td><td className="p-2">{row.revision}</td>
            {selected === 'PM_ANALYTICS_V' && <td className="p-2"><span className={`px-2 py-1 rounded-full whitespace-nowrap ${row.published ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-700'}`}>{row.published ? 'Published' : 'Not Published'}</span></td>}
            <td className="p-2"><details><summary className="cursor-pointer">View JSON</summary><pre className="max-h-80 max-w-xl overflow-auto whitespace-pre-wrap break-all p-2 bg-[var(--color-surface-hover)]">{formatPayload(row.payload)}</pre>{row.truncated && <p>Preview limited to 16,000 characters.</p>}</details></td>
          </tr>)}</tbody>
        </table></div>
        <div className="flex gap-3 items-center text-xs"><button disabled={page === 1 || loadingRows} onClick={() => setPage(value => value - 1)}>Previous</button>
          <span>Page {page} of {Math.max(1, Math.ceil(data.totalRows / 25))}</span>
          <button disabled={page * 25 >= data.totalRows || loadingRows} onClick={() => setPage(value => value + 1)}>Next</button></div>
      </>}
    </div>}
  </section>;
}
