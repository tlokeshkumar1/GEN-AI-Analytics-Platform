import { FolderDestination } from './FolderDestination';
import { useEffect, useState } from 'react';
import api from '../services/api';
import type { AnalyticsDefinition } from '../services/semanticService';
import { getRecommendations } from '../services/semanticService';
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
  useFiles,
} from './ContentFiles';

export function publishable(item: AnalyticsDefinition) {
  return (
    item.status === 'approved' &&
    Boolean(item.reviewer && item.reviewer !== 'system' && item.dataset_id && item.version)
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
  const { files, error: treeError } = useFiles();
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
  type Target = { id: string; name: string; page: string; revision: number };
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
    if (!targets.length || busy) return;
    if (chosen.some(i => !publishable(items[i]))) { setError('Approve the selected definitions in Widgets before publishing.'); return; }
    setBusy(true);
    setError('');
    try {
      const sources = chosen.map((i) => {
        const { dataset_id, version, semantic_revision, id, revision } = items[i];
        return { dataset_id, version, semantic_revision, id, revision };
      });
      for (const t of targets) {
        if (outcomes[t.id]?.count !== undefined) continue;
        try {
          const { data } = await api.post('/content/files/' + t.id + '/publish', {
            sources,
            request_id: requestId,
            revision: t.revision,
            page_id: t.page,
            duplicates,
          });
          setOutcomes((v) => ({ ...v, [t.id]: { count: data.placements_written } }));
          onPublished?.(chosen.map(i => items[i].id));
        } catch (err) {
          setOutcomes((v) => ({ ...v, [t.id]: { error: fileError(err) } }));
        }
      }
      contentChanged();
    } finally {
      setBusy(false);
    }
  }
  const current =
    doc && doc.id === id && page
      ? { id, name: filePath(files, doc), page, revision: doc.revision }
      : undefined;
  const targets = current ? [...extra.filter((t) => t.id !== id), current] : extra;
  const submitted = Object.keys(outcomes).length > 0;
  return (
    <FileDialog
      title="Publish to dashboard"
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
            <select className={fileInput} value={id} onChange={e => setId(e.target.value)}>
              <option value="">Choose dashboard</option>
              {files.filter(f => f.kind === 'dashboard' && f.permission !== 'view' &&
                (f.parent_id === parent || (f.permission === 'edit' && !parent)) &&
                filePath(files, f).toLowerCase().includes(search.toLowerCase())).map(f =>
                <option value={f.id} key={f.id}>{filePath(files, f)}</option>)}
            </select>
          </label>
          <button className={control} disabled={!parent} onClick={() => setForm('dashboard')}>+ New Dashboard</button>
        </div>
        {!files.some(f => f.kind === 'dashboard' && f.parent_id === parent && f.permission !== 'view') &&
          <p>No dashboards in this folder. Create a dashboard to continue.</p>}
        {doc && (
          <label>
            Page{' '}
            <select className={control} value={page} onChange={(e) => setPage(e.target.value)}>
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
        {extra.map((t) => (
          <div key={t.id}>
            {t.name}{' '}
            <button
              aria-label={'Remove ' + t.name}
              onClick={() => setExtra(extra.filter((x) => x.id !== t.id))}
            >
              Remove
            </button>
          </div>
        ))}
        {doc?.pages
          .find((p) => p.id === page)
          ?.widgets.some((w) =>
            chosen.some(
              (i) => w.source.dataset_id === items[i].dataset_id && w.source.id === items[i].id,
            ),
          ) && <p>Selected definitions already have placements on this page.</p>}
        <label>
          Existing placements{' '}
          <select
            value={duplicates}
            className={control}
            onChange={(e) => setDuplicates(e.target.value)}
          >
            <option value="skip">Skip duplicates</option>
            <option value="replace">Replace first match</option>
            <option value="add">Add another placement</option>
          </select>
        </label>
        <button
          className={filePrimaryButton}
          disabled={!chosen.length || !targets.length || (!!id && !current)}
          onClick={publish}
        >
          Publish selected ({chosen.length})
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
