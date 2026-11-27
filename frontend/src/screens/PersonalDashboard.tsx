import { SaveDashboardDialog } from '../components/SaveDashboard';
import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { refreshPersonalDashboard, type DashboardValue as Value } from '../services/personalDashboardService';
import { AnalyticsWidget } from '../components/AnalyticsWidget';
import { PersonalDashboardSkeleton } from '../components/dashboard/PersonalDashboardSkeleton';
import { DashboardAccess } from '../components/DashboardAccess';
import { PlacementFilters } from '../components/PlacementFilters';
import {
  control,
  contentChanged,
  Dashboard,
  fileError,
  filePath,
  useFiles,
} from '../components/ContentFiles';

export function PersonalDashboard({ id, navigate }: { id: string; navigate: (p: string) => void }) {
  const [doc, setDoc] = useState<Dashboard>();
  const [pageId, setPageId] = useState('');
  const [results, setResults] = useState<Record<string, Value>>({});
  const [loadingDocument, setLoadingDocument] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const loading = loadingDocument || loadingResults;
  const [error, setError] = useState('');
  const [seq, setSeq] = useState(0);
  const [saveAs, setSaveAs] = useState(false);
  const [actions, setActions] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [edit, setEdit] = useState(false);
  const [filterId, setFilterId] = useState('');
  const dragged = useRef<string | undefined>(undefined);
  const surface = useRef<HTMLElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(document.fullscreenElement === surface.current);
    syncFullscreen();
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<'access' | 'history'>();
  const { files } = useFiles();
  const preserveResults = useRef(false);
  const executionSignature = useRef('');
  const forceRefresh = useRef(false);
  useEffect(() => {
    const reload = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      preserveResults.current = detail?.dashboardId === id && detail?.layoutOnly === true;
      setSeq((n) => n + 1);
    };
    window.addEventListener('content-files-changed', reload);
    return () => window.removeEventListener('content-files-changed', reload);
  }, [id]);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    setLoadingDocument(true);
    if (!preserveResults.current) setResults({});
    api
      .get<Dashboard>('/content/files/' + id, { signal: abort.signal })
      .then(({ data }) => {
        if (abort.signal.aborted) return;
        if (data.kind !== 'dashboard') throw new Error('Select a dashboard.');
        setDoc({ ...data });
        const selectedPage = data.pages.find((p) => p.id === pageId) || data.pages[0];
        setLoadingResults(Boolean(selectedPage?.widgets.length));
        setPageId((p) => (data.pages.some((v) => v.id === p) ? p : data.pages[0].id));
      })
      .catch((err) => {
        if (!abort.signal.aborted) setError(fileError(err));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoadingDocument(false);
      });
    return () => abort.abort();
  }, [id, seq]);
  const page = doc?.pages.find((p) => p.id === pageId);
  useEffect(() => {
    const abort = new AbortController();
    const signature = JSON.stringify([id, page?.id, page?.widgets.map(w => [w.id, w.source]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
    if (preserveResults.current && signature === executionSignature.current) {
      preserveResults.current = false;
      setLoadingResults(false);
      return () => abort.abort();
    }
    preserveResults.current = false;
    executionSignature.current = '';
    setResults({});
    setLoadingResults(Boolean(page?.widgets.length));
    if (page?.widgets.length && doc) {
      const force = forceRefresh.current;
      forceRefresh.current = false;
      refreshPersonalDashboard(id, page.id, doc.revision, abort.signal, (key, value) => {
        if (!abort.signal.aborted) setResults(previous => ({ ...previous, [key]: value }));
      }, force)
        .then(() => {
          if (!abort.signal.aborted) executionSignature.current = signature;
        })
        .catch((err) => {
          if (!abort.signal.aborted) setError(fileError(err));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoadingResults(false);
        });
    }
    return () => abort.abort();
  }, [id, page, doc]);
  async function change(path: string, body: Record<string, unknown>, method: 'post' | 'patch') {
    if (!doc || busy) return;
    setBusy(true);
    setError('');
    try {
      await api[method]('/content/files/' + id + path, { ...body, revision: doc.revision });
      contentChanged({ dashboardId: id, layoutOnly: true });
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
      className="executive-dashboard personal-dashboard space-y-3.5 w-full max-w-[1560px] mx-auto pt-1 pb-16 bg-[var(--color-background-body)]"
    >
      <div className="text-xs text-slate-500">{doc ? filePath(files, doc) : 'My Files'}</div>
      <div className="flex flex-wrap items-center gap-2 py-2 px-1 border-b border-[var(--color-border)]">
        <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] border border-[var(--color-border)] flex items-center justify-center shrink-0">
          <span aria-hidden className="material-symbols-outlined text-[18px]">dashboard</span>
        </div>
        <h1 className="text-base font-semibold tracking-tight mr-auto">{doc?.name || 'Dashboard'}</h1>
        {(document.fullscreenEnabled || isFullscreen) && (
          <button
            className={control}
            aria-pressed={isFullscreen}
            onClick={() => {
              const task = document.fullscreenElement
                ? document.exitFullscreen()
                : surface.current?.requestFullscreen();
              task?.catch((err) => setError(fileError(err)));
            }}
          >
            {isFullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
        )}
        {doc && doc.permission !== 'view' && <>
          <button className={control} onClick={() => navigate('widgets')}>Configure KPIs</button>
          <button className={control} disabled={busy} onClick={async () => {
            setBusy(true); setError('');
            try {
              await api.post('/content/dashboards/save', { dashboard_id: doc.id, revision: doc.revision });
              contentChanged({ dashboardId: id, layoutOnly: true }); setSaveMessage('Dashboard saved.');
            } catch (err) { setError(fileError(err)); } finally { setBusy(false); }
          }}>Save</button>
        </>}
        <button className={`${control} inline-flex items-center gap-1.5 disabled:opacity-50`} disabled={loading} onClick={() => {
          setLoadingDocument(true);
          forceRefresh.current = true;
          preserveResults.current = false;
          setSeq((s) => s + 1);
        }}>
          <span aria-hidden className={`material-symbols-outlined text-[17px] ${loading ? 'motion-safe:animate-spin' : ''}`}>refresh</span>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {doc && doc.permission !== 'view' && <div className="relative">
          <button className={control} aria-label="Dashboard actions" aria-expanded={actions} onClick={() => setActions(!actions)}><span aria-hidden className="material-symbols-outlined text-[17px]">more_horiz</span></button>
          {actions && <div className="absolute right-0 z-10 grid gap-1 p-2 bg-[var(--color-background-surface)] border rounded shadow">
            <button className={control} aria-pressed={edit} onClick={() => { setEdit(!edit); setActions(false); }}>{edit ? 'Finish editing' : 'Edit layout'}</button>
            {doc.permission === 'owner' && <>
              <button className={control} onClick={() => { setSaveAs(true); setActions(false); }}>Save As</button>
              <button className={control} onClick={() => { setPanel('access'); setActions(false); }}>Share</button>
              <button className={control} onClick={() => { setPanel('history'); setActions(false); }}>History</button>
            </>}
          </div>}
        </div>}
        {saveAs && doc && <SaveDashboardDialog source={doc} close={() => setSaveAs(false)} saved={copy => { setSaveAs(false); navigate('dashboards/' + copy.id); }} />}
        {doc && panel && (
          <DashboardAccess
            doc={doc}
            history={panel === 'history'}
            close={() => setPanel(undefined)}
          />
        )}
      </div>
      {saveMessage && <p role="status">{saveMessage}</p>}
      {error && <p role="alert">{error}</p>}
      {loading && !doc && !error && <PersonalDashboardSkeleton />}
      {doc && (
        <>
          {doc.description && <p className="text-xs text-[var(--color-text-secondary)]">{doc.description}</p>}
          <div className="flex gap-2 flex-wrap">
            {doc.pages.map((p) => (
              <button
                className={control}
                aria-pressed={pageId === p.id}
                key={p.id}
                onClick={() => {
                  if (pageId === p.id) return;
                  setPageId(p.id);
                  setResults({});
                  setLoadingResults(Boolean(p.widgets.length));
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
          {loading && !Object.keys(results).length && !error && <PersonalDashboardSkeleton />}
          {!loading && !page?.widgets.length && (
            <div className="p-8 rounded-lg border text-center">
              <h2 className="font-semibold">Your page is ready for widgets</h2>
              <p className="my-2">Choose an approved KPI or chart and publish it to this page.</p>
              <button className={control} onClick={() => navigate('widgets')}>
                Open Widgets
              </button>
            </div>
          )}
          {(!loading || Object.keys(results).length > 0) && (['kpi', 'chart'] as const).map((group) => {
            const placements = page?.widgets.filter((w) => {
              const value = results[w.id];
              if (!value) return false;
              const isKpi = value && 'definition' in value && value.definition.kind === 'kpi';
              return group === 'kpi' ? isKpi : !isKpi;
            }) || [];
            if (!placements.length) return null;
            return (
          <div key={group} role="group" aria-label={group === 'kpi' ? 'Dashboard KPIs' : 'Dashboard charts'} className={group === 'kpi'
            ? 'grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2.5'
            : 'grid grid-cols-1 lg:grid-cols-2 gap-3.5'}>
            {placements.map((w) => {
              const value = results[w.id];
              const definition = value && 'definition' in value ? value.definition : undefined;
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
                  title={`Version ${w.source.version} · Semantic revision ${w.source.semantic_revision}`}
                  className={'group/card relative min-w-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] shadow-[var(--shadow-2xs)] hover:border-[var(--color-border-strong)] transition-all ' +
                    (group === 'kpi'
                      ? 'p-3 flex flex-col justify-between'
                      : 'p-3.5 space-y-2.5 hover:shadow-[var(--shadow-xs)]') +
                    (group === 'kpi'
                      ? ['', '', ' sm:col-span-2', ' sm:col-span-3'][w.width] || ''
                      : w.width > 1 ? ' lg:col-span-2' : '')}
                >
                  <div className={group === 'kpi' ? 'mb-2' : 'flex flex-wrap items-center gap-2 pb-2 border-b border-[var(--color-border)]'}>
                  <h2 className={group === 'kpi'
                    ? 'text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] break-words leading-snug'
                    : 'text-xs sm:text-sm font-semibold text-[var(--color-text-primary)] break-words leading-snug'}>
                    {w.title ||
                      (value && 'definition' in value ? value.definition.title : 'Widget')}
                  </h2>
                  {group === 'chart' && definition && <>
                    <span className="text-[10px] uppercase font-semibold tracking-wider px-1.5 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] text-[var(--color-text-secondary)] border border-[var(--color-border)] shrink-0">
                      {definition.kind.replace(/_/g, ' ')}
                    </span>
                    {definition.dataset_name && <span title={definition.dataset_name} className="text-[10px] font-medium px-2 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border border-[var(--color-border)] truncate max-w-[220px]">
                      {definition.dataset_name}
                    </span>}
                  </>}
                  </div>
                  {value ? (
                    'error' in value ? (
                      <p role="alert">{value.error}</p>
                    ) : (
                      <AnalyticsWidget
                        definition={value.definition}
                        result={value.result}
                        showTable={value.definition.kind === 'table'}
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
            );
          })}
          {loadingResults && Object.keys(results).length > 0 && !error && (
            <div role="status" aria-label="Loading remaining widgets" className="space-y-3.5">
              <span className="sr-only">Loading remaining widgets…</span>
              <div aria-hidden="true" className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 motion-safe:animate-pulse">
                {Array.from({ length: Math.min(4, (page?.widgets.length || 0) - Object.keys(results).length) }, (_, index) => (
                  <div key={index} className="h-72 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)]" />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
