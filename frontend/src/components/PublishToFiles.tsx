import { FolderDestination } from './FolderDestination';
import { useEffect, useState } from 'react';
import api from '../services/api';
import type { AnalyticsDefinition } from '../services/semanticService';
import { getRecommendations } from '../services/semanticService';
import { runWidgetTask } from '../services/widgetTaskQueue';
import {
  control,
  contentChanged,
  Dashboard,
  FileDialog,
  fileError,
  FileForm,
  filePath,
  fileInput,
  fileLabel,
  filePrimaryButton,
  fileSecondaryButton,
  useFiles,
} from './ContentFiles';

export function publishable(item: AnalyticsDefinition) {
  return (
    item.status === 'approved' &&
    // The API verifies system-reviewed widgets against their exact published revision.
    Boolean(item.reviewer && item.dataset_id && item.version && item.semantic_revision && item.revision)
  );
}

// Legacy recommendation surfaces resolve stored revisions instead of publishing raw plans.
export function usePublicationDestination(navigate: (path: string) => void = () => {}, onPublished?: (ids: string[]) => void) {
  const [objects, setObjects] = useState<AnalyticsDefinition[]>();
  const [destinationError, setDestinationError] = useState('');
  async function choose(items: AnalyticsDefinition[]) {
    setDestinationError('');
    setObjects(items);
  }
  async function chooseStored(ids: string[], datasetId?: string) {
    setDestinationError('');
    try {
      const available = (await getRecommendations(true, datasetId)).filter(i => ids.includes(i.id));
      if (available.length !== ids.length) throw new Error('Save and review the selected definitions in Widgets before publishing.');
      setObjects(available);
    } catch (err) { setDestinationError(fileError(err)); }
  }
  const destinationDialog = <>
    {destinationError && <p role="alert">{destinationError}</p>}
    {objects && <PublishToFiles items={objects} close={() => setObjects(undefined)} navigate={navigate} onPublished={onPublished} />}
  </>;
  return { choose, chooseStored, destinationDialog };
}

export function ApprovedPublicationAction({
  items,
  navigate,
}: {
  items?: AnalyticsDefinition[];
  navigate: (p: string) => void;
}) {
  const [objects, setObjects] = useState<AnalyticsDefinition[]>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  if (items && !items.some(publishable)) return null;
  async function open() {
    setLoading(true);
    setMessage('');
    try {
      const available = (items || (await getRecommendations(true))).filter(publishable);
      if (available.length) setObjects(available);
      else setMessage('Review a definition in Widgets before publishing.');
    } catch (err) {
      setMessage(fileError(err));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <button type="button" className={control} disabled={loading} onClick={open}>
        {loading ? 'Loading definitions…' : 'Publish approved objects to My Files'}
      </button>
      {message && <p role="status">{message}</p>}
      {objects && (
        <PublishToFiles items={objects} close={() => setObjects(undefined)} navigate={navigate} />
      )}
    </>
  );
}

export function PublishToFiles({
  items,
  close,
  navigate,
  onPublished,
}: {
  onPublished?: (ids: string[]) => void;
  items: AnalyticsDefinition[];
  close: () => void;
  navigate: (p: string) => void;
}) {
  const { files, error: treeError, loading: loadingTree } = useFiles();
  const [chosen, setChosen] = useState<number[]>(items.map((_, i) => i));
  const [id, setId] = useState('');
  const [search, setSearch] = useState('');
  const [doc, setDoc] = useState<Dashboard>();
  const [page, setPage] = useState('');
  const [form, setForm] = useState<'folder' | 'dashboard'>();
  const [parent, setParent] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState('skip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  type Target = { id: string; name: string; page: string; pageName?: string; revision: number };
  const [extra, setExtra] = useState<Target[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, { count?: number; error?: string }>>({});
  const [retry, setRetry] = useState(0);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    setRequestId(crypto.randomUUID());
    setOutcomes({});
  }, [chosen, page, duplicates, id, doc, extra]);
  useEffect(() => {
    const abort = new AbortController();
    setDoc(undefined);
    setPage('');
    setError('');
    if (id)
      api
        .get<Dashboard>('/content/files/' + id, { signal: abort.signal })
        .then(({ data }) => {
          if (!abort.signal.aborted) {
            setDoc(data);
            setPage(data.pages[0].id);
          }
        })
        .catch((err) => {
          if (!abort.signal.aborted) setError(fileError(err));
        });
    return () => abort.abort();
  }, [id, retry]);
  async function publish() {
    if (!chosen.length || !targets.length || busy || (!!id && !current)) return;
    if (chosen.some(i => !publishable(items[i]))) { setError('Approve the selected definitions in Widgets before publishing.'); return; }
    setBusy(true);
    setError('');
    try {
      const sources = chosen.map((i) => {
        const { dataset_id, version, semantic_revision, id, revision } = items[i];
        return { dataset_id, version, semantic_revision, id, revision };
      });
      await Promise.all(targets.map(async t => {
        if (outcomes[t.id]?.count !== undefined) return;
        try {
          const { data } = await runWidgetTask(() => api.post('/content/files/' + t.id + '/publish', {
            sources,
            request_id: requestId,
            revision: t.revision,
            page_id: t.page,
            duplicates,
          }));
          setOutcomes((v) => ({ ...v, [t.id]: { count: data.placements_written } }));
          onPublished?.(chosen.map(i => items[i].id));
        } catch (err) {
          setOutcomes((v) => ({ ...v, [t.id]: { error: fileError(err) } }));
        }
      }));
      contentChanged();
    } finally {
      setBusy(false);
    }
  }
  const current =
    doc && doc.id === id && page
      ? { id, name: filePath(files, doc), page, pageName: doc.pages.find(p => p.id === page)?.name, revision: doc.revision }
      : undefined;
  const targets = current ? [...extra.filter((t) => t.id !== id), current] : extra;
  const submitted = Object.keys(outcomes).length > 0;
  const unready = chosen.filter(i => !publishable(items[i]));
  return (
    <FileDialog
      title="Publish to dashboard"
      busy={busy}
      close={() => {
        if (!busy) close();
      }}
    >
      <fieldset disabled={busy || submitted} className="grid min-w-0 gap-4">
        <fieldset className="min-w-0 rounded-lg border border-[var(--color-border)] p-3">
          <legend className="px-1 text-sm font-semibold">Selected widgets ({chosen.length})</legend>
          <div className="max-h-44 space-y-2 overflow-y-auto">
          {items.map((item, i) => (
            <label className="flex min-w-0 items-start gap-2 rounded-md p-1.5 text-sm hover:bg-[var(--color-background-subtle)]" key={i}>
              <input
                type="checkbox"
                className="mt-1 shrink-0 accent-[var(--color-primary)]"
                checked={chosen.includes(i)}
                onChange={() =>
                  setChosen(chosen.includes(i) ? chosen.filter((n) => n !== i) : [...chosen, i])
                }
              />
              <span className="min-w-0 break-words"><span className="block font-medium">{item.title}</span><span className="block break-all text-xs text-[var(--color-text-muted)]">{item.kind} · {item.dataset_name || item.dataset_id} v{item.version}</span></span>
            </label>
          ))}
          </div>
        </fieldset>
        <input
          className={fileInput}
          aria-label="Search destinations"
          placeholder="Search destinations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <FolderDestination files={files} folder={parent || ''} onChange={value => { setParent(value); setId(''); }} />
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className={`${fileLabel} min-w-0 flex-1`}>Dashboard
            <select className={fileInput} disabled={loadingTree} value={id} onChange={e => setId(e.target.value)}>
              <option value="">Choose dashboard</option>
              {files.filter(f => f.kind === 'dashboard' && f.permission !== 'view' &&
                (f.parent_id === parent || (f.permission === 'edit' && !parent)) &&
                filePath(files, f).toLowerCase().includes(search.toLowerCase())).map(f =>
                <option value={f.id} key={f.id}>{filePath(files, f)}</option>)}
            </select>
          </label>
          <button type="button" className={`${fileSecondaryButton} shrink-0`} disabled={!parent || loadingTree} onClick={() => setForm('dashboard')}>+ New Dashboard</button>
        </div>
        {loadingTree && <p role="status" className="text-sm text-[var(--color-text-muted)]">Loading destinations…</p>}
        {id && !doc && !error && <p role="status" className="text-sm text-[var(--color-text-muted)]">Loading dashboard pages…</p>}
        {!loadingTree && parent && !files.some(f => f.kind === 'dashboard' && f.parent_id === parent && f.permission !== 'view') &&
          <p className="text-sm text-[var(--color-text-muted)]">No dashboards in this folder. Create a dashboard to continue.</p>}
        {doc && (
          <label className={fileLabel}>
            Page
            <select className={fileInput} value={page} onChange={(e) => setPage(e.target.value)}>
              {doc.pages.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {current && (
          <button
            className={control}
            onClick={() => {
              setExtra([...extra.filter((t) => t.id !== id), current]);
              setId('');
            }}
          >
            Include this destination and choose another
          </button>
        )}
        {targets.length > 0 && <section aria-label="Selected destinations" className="grid gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-background-subtle)] p-3">
          <h3 className="text-sm font-semibold">Selected destinations ({targets.length})</h3>
          <p className="text-xs text-[var(--color-text-muted)]">Widgets will be published to each dashboard listed below.</p>
          {targets.map(t => <div key={t.id} className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-background-surface)] p-3">
            <div className="min-w-0 text-sm">
              <p className="break-words font-medium">{t.name}</p>
              {t.pageName && <p className="mt-1 text-xs text-[var(--color-text-muted)]">Page: {t.pageName}</p>}
            </div>
            <button type="button" className={`${control} shrink-0`} aria-label={'Remove ' + t.name} onClick={() => {
              setExtra(extra.filter(x => x.id !== t.id));
              if (id === t.id) setId('');
            }}>Remove</button>
          </div>)}
        </section>}
        {doc?.pages
          .find((p) => p.id === page)
          ?.widgets.some((w) =>
            chosen.some(
              (i) => w.source.dataset_id === items[i].dataset_id && w.source.id === items[i].id,
            ),
          ) && <p>Selected definitions already have placements on this page.</p>}
        <label className={fileLabel}>
          Existing placements
          <select
            value={duplicates}
            className={fileInput}
            onChange={(e) => setDuplicates(e.target.value)}
          >
            <option value="skip">Skip duplicates</option>
            <option value="replace">Replace first match</option>
            <option value="add">Add another placement</option>
          </select>
        </label>
        {unready.length > 0 && <p role="status" className="rounded-lg border border-[var(--color-border)] bg-[var(--color-background-subtle)] p-3 text-sm text-[var(--color-text-secondary)]">
          {unready.length} selected widget(s) need approval or a saved source version. Review them in Widgets before publishing.
        </p>}
        <button
          type="button"
          className={filePrimaryButton}
          disabled={!chosen.length || !targets.length || (!!id && !current) || unready.length > 0 || loadingTree}
          onClick={publish}
        >
          {busy ? 'Publishing…' : `Publish selected (${chosen.length})`}
        </button>
      </fieldset>
      {(error || treeError) && (
        <p role="alert">
          {error || treeError}{' '}
          <button
            onClick={() => {
              setRetry((i) => i + 1);
              contentChanged();
            }}
          >
            Reload destination
          </button>
        </p>
      )}
      {targets.map(
        (t) =>
          outcomes[t.id] && (
            <p key={t.id} role="status">
              {t.name} · {outcomes[t.id].error || outcomes[t.id].count + ' placement(s) saved.'}{' '}
              {outcomes[t.id].count !== undefined && (
                <button
                  className={control}
                  onClick={() => {
                    close();
                    navigate('dashboards/' + t.id);
                  }}
                >
                  Open dashboard
                </button>
              )}
            </p>
          ),
      )}
      {Object.values(outcomes).some((o) => o.error) && (
        <button disabled={busy} onClick={publish}>
          Retry failed destinations
        </button>
      )}
      {form && (
        <FileForm
          key={`${form}:${parent}`}
          embedded
          kind={form}
          parent={parent}
          files={files}
          close={() => setForm(undefined)}
          saved={(f) => {
            if (f.kind === 'dashboard') { setParent(f.parent_id); setId(f.id); }
            else setParent(f.id);
            setForm(f.kind === 'folder' ? 'dashboard' : undefined);
          }}
        />
      )}
    </FileDialog>
  );
}
