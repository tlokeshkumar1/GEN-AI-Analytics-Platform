import React, { useEffect, useRef, useState } from 'react';
import { SidebarSection, sidebarChildren, sidebarItem } from './SidebarNavigation';
import api, { getApiErrorMessage } from '../services/api';

export interface FileEntry {
  favourite?: boolean;
  last_opened?: string;
  permission?: 'owner' | 'edit' | 'view';
  id: string;
  kind: 'folder' | 'dashboard';
  parent_id: string | null;
  name: string;
  description: string;
  revision: number;
  deleted: boolean;
}
export interface Placement {
  id: string;
  width: number;
  title: string;
  source: { id: string; dataset_id: string; version: number; semantic_revision: number };
}
export interface Dashboard extends FileEntry {
  grants?: Record<string, string>;
  pages: { id: string; name: string; widgets: Placement[] }[];
}
export const contentChanged = () => window.dispatchEvent(new Event('content-files-changed'));
export const fileError = (err: unknown) =>
  getApiErrorMessage(err, 'Could not complete this file operation.');
export const control =
  'rounded border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 py-1 text-sm';
export function filePath(files: FileEntry[], file: FileEntry): string {
  const parent = files.find((f) => f.id === file.parent_id);
  return (parent ? filePath(files, parent) : 'My Files') + ' / ' + file.name;
}
export function useFiles(deleted = false, archived = false) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let controller: AbortController;
    const load = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setLoading(true);
      setError('');
      try {
        const res = await api.get<FileEntry[]>('/content/tree', {
          params: { deleted, archived },
          signal: request.signal,
        });
        if (!Array.isArray(res.data)) throw new Error('The file tree response is invalid.');
        if (!request.signal.aborted) setFiles(res.data);
      } catch (err) {
        if (!request.signal.aborted) {
          setError(fileError(err));
          setFiles([]);
        }
      } finally {
        if (!request.signal.aborted) setLoading(false);
      }
    };
    void load();
    window.addEventListener('content-files-changed', load);
    return () => {
      controller.abort();
      window.removeEventListener('content-files-changed', load);
    };
  }, [deleted, archived]);
  return { files, loading, error };
}
export function FileDialog({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => { event.preventDefault(); close(); }}
      aria-label={title}
      className="m-auto w-[min(92vw,32rem)] rounded-xl p-6 shadow-xl backdrop:bg-black/40"
    >
      <header className="flex items-center justify-between mb-4">
        <h2 className="font-semibold">{title}</h2>
        <button aria-label="Close dialog" onClick={close}>
          ✕
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function FileForm({
  kind,
  files,
  parent,
  item,
  saved,
  close,
  embedded = false,
}: {
  embedded?: boolean;
  kind: FileEntry['kind'];
  files: FileEntry[];
  parent: string | null;
  item?: FileEntry;
  saved: (file: FileEntry) => void;
  close: () => void;
}) {
  const [name, setName] = useState(item?.name || '');
  const [desc, setDesc] = useState(item?.description || '');
  const [first, setFirst] = useState('');
  const [destination, setDestination] = useState(parent || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const body = (
      <form
        className="grid gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          const fields = { name, description: desc, parent_id: destination || null };
          try {
            const { data } = item
              ? await api.patch('/content/files/' + item.id, { ...fields, revision: item.revision })
              : await api.post('/content/files', {
                  ...fields,
                  kind,
                  ...(first.trim() ? { first_dashboard: first.trim() } : {}),
                });
            contentChanged();
            saved(data.first_dashboard || data);
          } catch (err) {
            setError(fileError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="grid">
          Name
          <input
            autoFocus
            required
            maxLength={120}
            className={control}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="grid">
          Description
          <textarea
            maxLength={2000}
            className={control}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </label>
        <label className="grid">
          Destination folder
          <select
            className={control}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
          >
            <option value="" disabled={kind === 'dashboard' && !item}>{kind === 'folder' ? 'My Files' : 'Choose folder'}</option>
            {files
              .filter((f) => f.kind === 'folder' && f.id !== item?.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {filePath(files, f)}
                </option>
              ))}
          </select>
        </label>
        {kind === 'folder' && !item && !embedded && (
          <label className="grid">
            First dashboard name (optional)
            <input
              className={control}
              maxLength={120}
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <button disabled={busy || !name.trim() || (kind === 'dashboard' && !item && !destination)} className={control}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {embedded && <button type="button" className={control} onClick={close}>Cancel creation</button>}
      </form>
  );
  return embedded ? body : <FileDialog title={`${item ? 'Edit' : 'Create'} ${kind}`} close={close}>{body}</FileDialog>;
}
export function ContentFiles({
  navigate,
  active,
  userKey,
}: {
  navigate: (p: string) => void;
  active: string;
  userKey: string;
}) {
  const [view, setView] = useState('My Files');
  const bin = view === 'Recycle bin';
  const archive = view === 'Archive';
  const flat = view !== 'My Files';
  const { files: activeFiles, error: activeError, loading } = useFiles();
  const { files: archivedFiles, error: archiveError } = useFiles(false, true);
  const { files: deletedFiles, error: binError } = useFiles(true);
  const files = bin ? deletedFiles : archive ? archivedFiles : activeFiles;
  const error = activeError || archiveError || binError;
  const isActive = active === 'my-files' || active.startsWith('dashboards/');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState<{
    kind: FileEntry['kind'];
    parent: string | null;
    item?: FileEntry;
  }>();
  const [folded, setFolded] = useState<string[]>([]);
  useEffect(() => {
    if (!isActive) return;
    const ancestors = ['root'];
    let parent = activeFiles.find(f => active === 'dashboards/' + f.id)?.parent_id;
    while (parent && !ancestors.includes(parent)) {
      ancestors.push(parent);
      parent = activeFiles.find(f => f.id === parent)?.parent_id;
    }
    setFolded(prev => prev.filter(id => !ancestors.includes(id)));
  }, [active, activeFiles]);
  const revision = useRef(0);
  const saving = useRef(false);
  useEffect(() => {
    const request = new AbortController();
    async function loadPreferences() {
      try {
        const { data } = await api.get('/content/preferences', { signal: request.signal });
        if (!Array.isArray(data.folded))
          throw new Error('The folder preferences response is invalid.');
        if (!request.signal.aborted) {
          revision.current = data.revision;
          setFolded(isActive ? data.folded.filter((id: string) => id !== 'root') : data.folded);
        }
      } catch (err) {
        if (!request.signal.aborted) setMessage(fileError(err));
      }
    }
    void loadPreferences();
    return () => request.abort();
  }, [userKey]);
  async function fold(next: string[]) {
    if (saving.current) return;
    saving.current = true;
    try {
      const { data } = await api.put('/content/preferences', {
        folded: next,
        revision: revision.current,
      });
      setFolded(data.folded);
      revision.current = data.revision;
    } catch (err) {
      setMessage(fileError(err));
      try {
        const { data } = await api.get('/content/preferences');
        revision.current = data.revision;
        setFolded(data.folded);
      } catch {
        /* Keep the last confirmed selection. */
      }
    } finally {
      saving.current = false;
    }
  }
  function toggle(id: string) {
    fold(folded.includes(id) ? folded.filter((k) => k !== id) : [...folded, id]);
  }
  async function trash(f: FileEntry) {
    if (!bin && !window.confirm('Move ' + f.name + ' and its contents to the recycle bin?')) return;
    try {
      await api.patch('/content/files/' + f.id, { revision: f.revision, deleted: !bin });
      setMenu('');
      contentChanged();
    } catch (err) {
      setMessage(fileError(err));
    }
  }
  async function changeFlag(f: FileEntry, flag: 'archived' | 'favourite') {
    try {
      if (flag === 'archived')
        await api.patch('/content/files/' + f.id, { revision: f.revision, archived: !archive });
      else await api.put('/content/files/' + f.id + '/favourite', { favourite: !f.favourite });
      setMenu('');
      contentChanged();
    } catch (err) {
      setMessage(fileError(err));
    }
  }
  function row(f: FileEntry): React.ReactNode {
    return (
      <li key={f.id}>
        <div className="flex items-center gap-1 min-w-0">
          <button
            className={sidebarItem(active === 'dashboards/' + f.id)}
            aria-current={active === 'dashboards/' + f.id ? 'page' : undefined}
            aria-expanded={f.kind === 'folder' ? !folded.includes(f.id) : undefined}
            onClick={() => {
              if (f.kind === 'folder') {
                if (flat) {
                  setView('My Files');
                  setQuery(f.name);
                } else toggle(f.id);
                void api
                  .post('/content/files/' + f.id + '/opened')
                  .catch((err) => setMessage(fileError(err)));
              } else navigate('dashboards/' + f.id);
            }}
            disabled={bin || archive}
          >
            {active === 'dashboards/' + f.id && <span aria-hidden className="absolute left-0 top-1.5 bottom-1.5 w-1 rounded-r-full bg-[var(--color-primary)]" />}
            <span className="flex items-center gap-2.5 min-w-0">
            <span aria-hidden className="material-symbols-outlined text-[17px] text-black shrink-0">
              {f.kind === 'folder' ? 'folder' : 'dashboard'}
            </span>
            <span className="truncate text-black font-medium">
              {query ? filePath(files, f) : f.name}
            </span></span>
            {f.kind === 'folder' && <span aria-hidden className={`material-symbols-outlined text-[16px] transition-transform ${folded.includes(f.id) ? '' : 'rotate-180'}`}>keyboard_arrow_down</span>}
          </button>
          {
            <button
              aria-label={'Actions for ' + f.name}
              onClick={() => setMenu(menu === f.id ? '' : f.id)}
            >
              <span aria-hidden className="material-symbols-outlined text-[17px]">more_horiz</span>
            </button>
          }
        </div>
        {menu === f.id && (
          <div className="grid text-left border-l pl-2">
            {!bin && !archive && (
              <button onClick={() => changeFlag(f, 'favourite')}>
                {f.favourite ? 'Remove favourite' : 'Add to favourites'}
              </button>
            )}
            {!bin && f.permission === 'owner' && (
              <button onClick={() => changeFlag(f, 'archived')}>
                {archive ? 'Unarchive' : 'Archive'}
              </button>
            )}
            {!bin && !archive && f.permission === 'owner' && (
              <>
                <button onClick={() => setForm({ kind: f.kind, parent: f.parent_id, item: f })}>
                  Rename, move or edit
                </button>
                {f.kind === 'dashboard' && (
                  <button
                    onClick={async () => {
                      const name = window.prompt(
                        'Name for duplicate dashboard',
                        f.name + ' (copy)',
                      );
                      if (!name?.trim()) return;
                      try {
                        const { data } = await api.post('/content/files/' + f.id + '/duplicate', {
                          kind: 'dashboard',
                          name,
                          parent_id: f.parent_id,
                          description: f.description,
                        });
                        setMenu('');
                        contentChanged();
                        navigate('dashboards/' + data.id);
                      } catch (err) {
                        setMessage(fileError(err));
                      }
                    }}
                  >
                    Duplicate dashboard
                  </button>
                )}
                {f.kind === 'folder' &&
                  (['folder', 'dashboard'] as const).map((kind) => (
                    <button key={kind} onClick={() => setForm({ kind, parent: f.id })}>
                      Create {kind}
                    </button>
                  ))}
              </>
            )}
            {f.permission === 'owner' && !archive && (
              <button onClick={() => void trash(f)}>{bin ? 'Restore' : 'Delete'}</button>
            )}
          </div>
        )}
        {!query && !flat && f.kind === 'folder' && !folded.includes(f.id) && (
          <ul className={sidebarChildren}>{files.filter((c) => c.parent_id === f.id).map(row)}</ul>
        )}
      </li>
    );
  }
  return (
    <section aria-label="Personal files" className="text-xs py-1">
      <SidebarSection label="My Files" icon="folder" active={isActive}
        open={!folded.includes('root')} toggle={() => toggle('root')}>
          <button className={sidebarItem()} onClick={() => {
            setView('My Files'); setForm({ kind: 'folder', parent: null });
          }}><span className="flex items-center gap-2.5"><span aria-hidden className="material-symbols-outlined text-[17px]">add</span><span>+ Add Files</span></span></button>
          {[
            ...(activeFiles.some(f => f.permission && f.permission !== 'owner') ? ['Shared with me'] : []),
            ...(activeFiles.some(f => f.favourite) ? ['Favourites'] : []),
            ...(activeFiles.some(f => f.last_opened) ? ['Recently viewed'] : []),
            ...(archivedFiles.length ? ['Archive'] : []),
            ...(deletedFiles.length ? ['Recycle bin'] : []),
          ].map(v => <button key={v} className={sidebarItem(view === v)} onClick={() => {
            setView(v); setQuery(''); setMenu('');
          }}>{v}</button>)}
          {flat && (
            <button className="block" onClick={() => setView('My Files')}>
              ← {view}
            </button>
          )}
          {!!files.length && (
            <input
              aria-label="Search files"
              placeholder="Search files"
              className="w-full my-1 border-b p-1"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          {loading && <p role="status">Loading files…</p>}
          {(error || message) && (
            <div role="alert">
              {error || message}{' '}
              <button
                onClick={() => {
                  setMessage('');
                  contentChanged();
                }}
              >
                Retry
              </button>
            </div>
          )}
          <ul className="max-h-72 overflow-auto">
            {files
              .filter((f) =>
                view === 'Favourites'
                  ? f.favourite
                  : view === 'Shared with me'
                    ? f.permission !== 'owner'
                    : view === 'Recently viewed'
                      ? f.last_opened
                      : true,
              )
              .sort((a, b) =>
                view === 'Recently viewed'
                  ? (b.last_opened || '').localeCompare(a.last_opened || '')
                  : 0,
              )
              .filter((f) =>
                query
                  ? (f.name + ' ' + f.description).toLowerCase().includes(query.toLowerCase())
                  : flat || !f.parent_id,
              )
              .map(row)}
          </ul>
      </SidebarSection>
      {form && (
        <FileForm
          key={`${form.kind}:${form.parent}:${form.item?.id || 'new'}`}
          {...form}
          files={activeFiles}
          close={() => setForm(undefined)}
          saved={(f) => {
            setForm(f.kind === 'folder' && !form.item ? { kind: 'dashboard', parent: f.id } : undefined);
            setMenu('');
            let p = f.parent_id;
            const ancestors = ['root'];
            while (p) {
              ancestors.push(p);
              p = files.find((i) => i.id === p)?.parent_id || null;
            }
            fold(folded.filter((i) => !ancestors.includes(i)));
            if (f.kind === 'dashboard') navigate('dashboards/' + f.id);
          }}
        />
      )}
    </section>
  );
}
