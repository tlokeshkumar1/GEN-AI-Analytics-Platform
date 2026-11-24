import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import type { AnalyticsDefinition, ExecutionResult } from '../services/semanticService';
import { AnalyticsWidget } from '../components/AnalyticsWidget';
import { DashboardAccess } from '../components/DashboardAccess';
import { PlacementFilters, type ScopedFilters } from '../components/PlacementFilters';
import {
  control,
  contentChanged,
  Dashboard,
  fileError,
  filePath,
  useFiles,
} from '../components/ContentFiles';

type Value =
  | {
      definition: AnalyticsDefinition;
      result: ExecutionResult;
      filters: ScopedFilters;
      filter_fields: string[];
    }
  | { error: string };
export function PersonalDashboard({ id, navigate }: { id: string; navigate: (p: string) => void }) {
  const [doc, setDoc] = useState<Dashboard>();
  const [pageId, setPageId] = useState('');
  const [results, setResults] = useState<Record<string, Value>>({});
  const [error, setError] = useState('');
  const [seq, setSeq] = useState(0);
  const [edit, setEdit] = useState(false);
  const [filterId, setFilterId] = useState('');
  const dragged = useRef<string | undefined>(undefined);
  const surface = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'access' | 'history'>();
  const { files } = useFiles();
  useEffect(() => {
    const abort = new AbortController();
    api.post('/content/files/' + id + '/opened', null, { signal: abort.signal }).catch((err) => {
      if (!abort.signal.aborted) setError(fileError(err));
    });
    return () => abort.abort();
  }, [id]);
  useEffect(() => {
    const reload = () => setSeq((n) => n + 1);
    window.addEventListener('content-files-changed', reload);
    return () => window.removeEventListener('content-files-changed', reload);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    setDoc(undefined);
    setResults({});
    api
      .get<Dashboard>('/content/files/' + id, { signal: abort.signal })
      .then(({ data }) => {
        if (abort.signal.aborted) return;
        if (data.kind !== 'dashboard') throw new Error('Select a dashboard.');
        setDoc(data);
        setPageId((p) => (data.pages.some((v) => v.id === p) ? p : data.pages[0].id));
      })
      .catch((err) => {
        if (!abort.signal.aborted) setError(fileError(err));
      });
    return () => abort.abort();
  }, [id, seq]);
  const page = doc?.pages.find((p) => p.id === pageId);
  useEffect(() => {
    const abort = new AbortController();
    setResults({});
    if (page?.widgets.length)
      api
        .post('/content/files/' + id + '/refresh', null, {
          params: { page_id: page.id },
          signal: abort.signal,
        })
        .then(({ data }) => {
          if (abort.signal.aborted) return;
          if (data.revision !== doc?.revision) {
            setError('Dashboard changed. Refresh to view the latest layout.');
            return;
          }
          setResults(data.widgets);
        })
        .catch((err) => {
          if (!abort.signal.aborted) setError(fileError(err));
        });
    return () => abort.abort();
  }, [id, page, doc]);
  async function change(path: string, body: Record<string, unknown>, method: 'post' | 'patch') {
    if (!doc || busy) return;
    setBusy(true);
    setError('');
    try {
      await api[method]('/content/files/' + id + path, { ...body, revision: doc.revision });
      contentChanged();
    } catch (err) {
      setError(fileError(err));
    } finally {
      setBusy(false);
    }
  }
  function pageAction(action: string) {
    const name = ['add', 'rename', 'duplicate'].includes(action)
      ? window.prompt('Page name', action === 'rename' ? page?.name : '')
      : undefined;
    if (
      name === null ||
      name === '' ||
      (action === 'remove' && !window.confirm('Delete this page and its placements?'))
    )
      return;
    void change('/pages', { action, page_id: pageId, name }, 'post');
  }
  return (
    <section
      ref={surface}
      className="p-5 space-y-4 bg-[var(--color-background-body)] overflow-y-auto"
    >
      <div className="text-xs text-slate-500">{doc ? filePath(files, doc) : 'My Files'}</div>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-2xl font-semibold mr-auto">{doc?.name || 'Dashboard'}</h1>
        {document.fullscreenEnabled && (
          <button
            className={control}
            onClick={() => {
              const task = document.fullscreenElement
                ? document.exitFullscreen()
                : surface.current?.requestFullscreen();
              task?.catch((err) => setError(fileError(err)));
            }}
          >
            Full screen
          </button>
        )}
        <button className={control} onClick={() => setSeq((s) => s + 1)}>
          Refresh
        </button>
        {doc && doc.permission !== 'view' && (
          <button className={control} aria-pressed={edit} onClick={() => setEdit(!edit)}>
            {edit ? 'Finish editing' : 'Edit layout'}
          </button>
        )}
        {doc?.permission === 'owner' && (
          <>
            <button className={control} onClick={() => setPanel('access')}>
              Share
            </button>
            <button className={control} onClick={() => setPanel('history')}>
              History
            </button>
          </>
        )}
        {doc && panel && (
          <DashboardAccess
            doc={doc}
            history={panel === 'history'}
            close={() => setPanel(undefined)}
          />
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!doc && !error && <p role="status">Loading dashboard…</p>}
      {doc && (
        <>
          <p>{doc.description}</p>
          <div className="flex gap-2 flex-wrap">
            {doc.pages.map((p) => (
              <button
                className={control}
                aria-pressed={pageId === p.id}
                key={p.id}
                onClick={() => {
                  setPageId(p.id);
                  setResults({});
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          {edit && (
            <fieldset disabled={busy} className="flex gap-2 flex-wrap">
              {['add', 'rename', 'duplicate', 'up', 'down', 'remove'].map((a) => (
                <button className={control} key={a} onClick={() => pageAction(a)}>
                  {a} page
                </button>
              ))}
            </fieldset>
          )}
          {!page?.widgets.length && (
            <div className="p-8 rounded-lg border text-center">
              <h2 className="font-semibold">Your page is ready for widgets</h2>
              <p className="my-2">Choose an approved KPI or chart and publish it to this page.</p>
              <button className={control} onClick={() => navigate('widgets')}>
                Open Widgets
              </button>
            </div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {page?.widgets.map((w) => {
              const value = results[w.id];
              const mutate = (action: string, opts = {}) =>
                change('/widgets/' + w.id, { action, ...opts }, 'patch');
              return (
                <article
                  key={w.id}
                  draggable={edit && !busy}
                  onDragStart={(event) => {
                    dragged.current = w.id;
                    event.dataTransfer.setData('text/plain', w.id);
                  }}
                  onDragEnd={() => {
                    dragged.current = undefined;
                  }}
                  onDragOver={(event) => {
                    if (edit && dragged.current) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (edit && dragged.current && dragged.current !== w.id)
                      void change(
                        '/widgets/' + dragged.current,
                        { action: 'move', target_id: w.id },
                        'patch',
                      );
                    dragged.current = undefined;
                  }}
                  className={
                    'border rounded-lg p-4 min-w-0 ' +
                    ['', 'lg:col-span-1', 'lg:col-span-2', 'lg:col-span-3'][w.width]
                  }
                >
                  <h2 className="font-semibold">
                    {w.title ||
                      (value && 'definition' in value ? value.definition.title : 'Widget')}
                  </h2>
                  <small>
                    Version {w.source.version} · Semantic revision {w.source.semantic_revision}
                  </small>
                  {value ? (
                    'error' in value ? (
                      <p role="alert">{value.error}</p>
                    ) : (
                      <AnalyticsWidget
                        definition={value.definition}
                        result={value.result}
                        isDashboard
                      />
                    )
                  ) : (
                    <p role="status">Loading result…</p>
                  )}
                  {edit && (
                    <fieldset className="flex gap-1 flex-wrap" disabled={busy}>
                      {value && 'definition' in value && (
                        <button className={control} onClick={() => setFilterId(w.id)}>
                          Filters
                        </button>
                      )}
                      {filterId === w.id && value && 'definition' in value && (
                        <PlacementFilters
                          dashboard={id}
                          revision={doc.revision}
                          placement={w.id}
                          fields={value.filter_fields}
                          filters={value.filters}
                          close={() => setFilterId('')}
                        />
                      )}
                      <button
                        className={control}
                        onClick={() => {
                          const title = window.prompt('Widget title', w.title);
                          if (title !== null) void mutate('edit', { title, width: w.width });
                        }}
                      >
                        Title
                      </button>
                      <label>
                        Width{' '}
                        <select
                          value={w.width}
                          onChange={(e) =>
                            void mutate('edit', { width: Number(e.target.value), title: w.title })
                          }
                        >
                          {[1, 2, 3].map((i) => (
                            <option key={i}>{i}</option>
                          ))}
                        </select>
                      </label>
                      {['up', 'down', 'duplicate', 'remove'].map((a) => (
                        <button className={control} key={a} onClick={() => void mutate(a)}>
                          {a}
                        </button>
                      ))}
                    </fieldset>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
