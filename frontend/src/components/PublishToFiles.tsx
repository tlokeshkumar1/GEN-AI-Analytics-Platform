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
  useFiles,
} from './ContentFiles';

function publishable(item: AnalyticsDefinition) {
  return (
    item.status === 'approved' &&
    Boolean(item.reviewer && item.reviewer !== 'system' && item.dataset_id && item.version)
  );
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
}: {
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
      <fieldset disabled={busy || submitted} className="grid gap-3">
        <fieldset className="max-h-40 overflow-auto">
          <legend>Approved objects</legend>
          {items.map((item, i) => (
            <label className="block text-sm" key={i}>
              <input
                type="checkbox"
                checked={chosen.includes(i)}
                onChange={() =>
                  setChosen(chosen.includes(i) ? chosen.filter((n) => n !== i) : [...chosen, i])
                }
              />{' '}
              {item.title} · {item.kind} · {item.dataset_name} v{item.version}
            </label>
          ))}
        </fieldset>
        <input
          className={control}
          aria-label="Search destinations"
          placeholder="Search destinations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label>
          Destination
          <select
            className={control + ' w-full'}
            value={id}
            onChange={(e) => setId(e.target.value)}
          >
            <option value="">Choose dashboard</option>
            {files
              .filter(
                (f) =>
                  f.kind === 'dashboard' &&
                  f.permission !== 'view' &&
                  (f.id === id || filePath(files, f).toLowerCase().includes(search.toLowerCase())),
              )
              .map((f) => (
                <option value={f.id} key={f.id}>
                  {filePath(files, f)}
                </option>
              ))}
          </select>
        </label>
        <div className="flex gap-2">
          <button className={control} onClick={() => setForm('folder')}>
            Create folder
          </button>
          <button className={control} onClick={() => setForm('dashboard')}>
            Create dashboard
          </button>
        </div>
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
          className={control}
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
          kind={form}
          parent={parent}
          files={files}
          close={() => setForm(undefined)}
          saved={(f) => {
            if (f.kind === 'dashboard') setId(f.id);
            else setParent(f.id);
            setForm(f.kind === 'folder' ? 'dashboard' : undefined);
          }}
        />
      )}
    </FileDialog>
  );
}
