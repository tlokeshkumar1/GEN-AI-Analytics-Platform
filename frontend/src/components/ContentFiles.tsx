import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Copy, FolderPlus, LayoutDashboard, LoaderCircle, MoreHorizontal, Pencil, RotateCcw, Search, Star, Trash2, X } from 'lucide-react';
import { FileActionsMenu, fileMenuItem } from './FileActionsMenu';
import { SidebarSection, sidebarChildren, sidebarItem } from './SidebarNavigation';
import api, { getApiErrorMessage } from '../services/api';
import { useFileTree } from '../services/fileTreeCache';

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
export const contentChanged = (detail?: { dashboardId: string; layoutOnly: boolean }) => window.dispatchEvent(new CustomEvent('content-files-changed', { detail }));
export const fileError = (err: unknown) =>
  getApiErrorMessage(err, 'Could not complete this file operation.');
export const control =
  'rounded border border-[var(--color-border)] bg-[var(--color-background-surface)] px-2 py-1 text-sm';
export const fileInput = 'w-full min-w-0 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-background-surface)] px-3 py-2.5 text-sm text-[var(--color-text-primary)] outline-none transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[var(--color-primary-muted)] disabled:opacity-60';
export const fileLabel = 'grid gap-1.5 text-sm font-medium text-[var(--color-text-secondary)]';
export const filePrimaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[var(--color-primary)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-primary-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50';
export const fileSecondaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-background-surface)] px-3 py-2 text-sm font-medium text-[var(--color-text-secondary)] transition hover:bg-[var(--color-background-subtle)] disabled:cursor-not-allowed disabled:opacity-50';
export function filePath(files: FileEntry[], file: FileEntry): string {
  const parent = files.find((f) => f.id === file.parent_id);
  return (parent ? filePath(files, parent) : 'My Files') + ' / ' + file.name;
}
export const useFiles = useFileTree;
export function FileDialog({
  title,
  children,
  close,
  busy = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  busy?: boolean;
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
      aria-busy={busy}
      className="m-auto max-h-[85vh] w-[min(92vw,32rem)] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-background-surface)] p-6 text-sm text-[var(--color-text-primary)] shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-sm"
    >
      <header className="mb-5 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <button type="button" aria-label="Close dialog" disabled={busy} onClick={close} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background-subtle)] disabled:opacity-40">
          <X aria-hidden="true" size={18} />
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
        className="grid gap-4" aria-busy={busy}
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
        <label className={fileLabel}>
          {embedded && kind === 'folder' ? 'Folder name' : 'Name'}
          <input
            autoFocus
            disabled={busy}
            required
            maxLength={120}
            className={fileInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className={fileLabel}>
          Description
          <textarea
            disabled={busy}
            maxLength={2000}
            className={fileInput}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
        </label>
        <label className={fileLabel}>
          Destination folder
          <select
            disabled={busy}
            className={fileInput}
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
          <label className={fileLabel}>
            First dashboard name (optional)
            <input
              className={fileInput}
              maxLength={120}
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
          </label>
        )}
        {error && <p role="alert" className="rounded-lg bg-[var(--color-error-soft)] px-3 py-2 text-sm text-[var(--color-error)]">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {embedded && <button type="button" disabled={busy} className={fileSecondaryButton} onClick={close}>Cancel creation</button>}
          <button type="submit" disabled={busy || !name.trim() || (kind === 'dashboard' && !item && !destination)} className={filePrimaryButton}>
            {busy && <LoaderCircle aria-hidden="true" size={16} className="shrink-0 animate-spin motion-reduce:animate-none" />}
            <span role={busy ? 'status' : undefined}>{busy ? 'Saving…' : embedded ? `Create ${kind}` : 'Save'}</span>
          </button>
        </div>
      </form>
  );
  return embedded ? body : <FileDialog title={`${item ? 'Edit' : 'Create'} ${kind}`} busy={busy} close={() => { if (!busy) close(); }}>{body}</FileDialog>;
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
  const bin = view === 'Deleted Files';
  const archive = view === 'Archive';
  const flat = view !== 'My Files';
  const activeTree = useFiles();
  const archiveTree = useFiles(false, true, archive);
  const deletedTree = useFiles(true, false, bin);
  const activeFiles = activeTree.files;
  const { files, loading } = bin ? deletedTree : archive ? archiveTree : activeTree;
  const isActive = active === 'my-files' || active.startsWith('dashboards/');
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState('');
  const closeMenu = useCallback(() => setMenu(''), []);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
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
  const pendingFold = useRef<string[] | undefined>(undefined);
  const foldedRef = useRef(folded);
  foldedRef.current = folded;
  const preferencesReady = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const request = new AbortController();
    async function loadPreferences() {
      try {
        const { data } = await api.get('/content/preferences', { signal: request.signal });
        if (!Array.isArray(data.folded))
          throw new Error('The folder preferences response is invalid.');
        if (!request.signal.aborted) {
          revision.current = data.revision;
          if (!saving.current) setFolded(isActive ? data.folded.filter((id: string) => id !== 'root') : data.folded);
        }
      } catch {
        // Keep the default expansion when saved sidebar preferences are unavailable.
      }
    }
    preferencesReady.current = loadPreferences();
    return () => request.abort();
  }, [userKey]);
  async function fold(next: string[]) {
    foldedRef.current = next;
    setFolded(next);
    pendingFold.current = next;
    if (saving.current) return;
    saving.current = true;
    try {
      await preferencesReady.current;
      while (pendingFold.current) {
        const target = pendingFold.current;
        pendingFold.current = undefined;
        const { data } = await api.put('/content/preferences', {
          folded: target,
          revision: revision.current,
        });
        revision.current = data.revision;
      }
    } catch (err) {
      setMessage(fileError(err));
      try {
        const { data } = await api.get('/content/preferences');
        revision.current = data.revision;
        // Keep the user's immediate selection even if saving failed.
      } catch {
        /* Keep the user's immediate selection. */
      }
    } finally {
      saving.current = false;
      const pending = pendingFold.current;
      if (pending) void fold(pending);
    }
  }
  function toggle(id: string) {
    const current = foldedRef.current;
    void fold(current.includes(id) ? current.filter((k) => k !== id) : [...current, id]);
  }
  async function trash(f: FileEntry) {
    if (!bin && !window.confirm('Move ' + f.name + ' and its contents to Deleted Files?')) return;
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
        <div className="group/file-row flex items-center gap-1 min-w-0">
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
              type="button"
              aria-label={'Actions for ' + f.name}
              aria-haspopup="menu"
              aria-expanded={menu === f.id}
              aria-controls={menu === f.id ? 'file-actions-menu-' + f.id : undefined}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none transition-[opacity,background-color,color] group-hover/file-row:opacity-100 group-focus-within/file-row:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-[var(--color-background-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${menu === f.id ? 'opacity-100 bg-[var(--color-primary-soft)] text-[var(--color-primary)]' : 'opacity-0 text-[var(--color-text-muted)]'}`}
              onClick={event => {
                menuAnchor.current = event.currentTarget;
                setMenu(menu === f.id ? '' : f.id);
              }}
            >
              <MoreHorizontal aria-hidden="true" size={18} />
            </button>
          }
        </div>
        {menu === f.id && menuAnchor.current && (
          <FileActionsMenu anchor={menuAnchor.current} label={f.name} close={closeMenu}>
            {!bin && !archive && (
              <button type="button" role="menuitem" className={fileMenuItem} onClick={() => changeFlag(f, 'favourite')}>
                <Star aria-hidden="true" size={16} />
                {f.favourite ? 'Remove favourite' : 'Add to favourites'}
              </button>
            )}
            {!bin && f.permission === 'owner' && (
              <button type="button" role="menuitem" className={fileMenuItem} onClick={() => changeFlag(f, 'archived')}>
                <Archive aria-hidden="true" size={16} />
                {archive ? 'Unarchive' : 'Archive'}
              </button>
            )}
            {!bin && !archive && f.permission === 'owner' && (
              <>
                <button type="button" role="menuitem" className={fileMenuItem} onClick={() => setForm({ kind: f.kind, parent: f.parent_id, item: f })}>
                  <Pencil aria-hidden="true" size={16} />
                  Rename, move or edit
                </button>
                {f.kind === 'dashboard' && (
                  <button
                    type="button" role="menuitem" className={fileMenuItem}
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
                    <Copy aria-hidden="true" size={16} />Duplicate dashboard
                  </button>
                )}
                {f.kind === 'folder' &&
                  (['folder', 'dashboard'] as const).map((kind) => (
                    <button type="button" role="menuitem" className={fileMenuItem} key={kind} onClick={() => setForm({ kind, parent: f.id })}>
                      {kind === 'folder' ? <FolderPlus aria-hidden="true" size={16} /> : <LayoutDashboard aria-hidden="true" size={16} />}
                      Create {kind}
                    </button>
                  ))}
              </>
            )}
            {f.permission === 'owner' && !archive && (
              <div className="mt-1 border-t border-[var(--color-border)] pt-1">
                <button type="button" role="menuitem" className={`${fileMenuItem} ${!bin ? 'text-[var(--color-error)] hover:bg-[var(--color-error-soft)] focus:bg-[var(--color-error-soft)] focus:text-[var(--color-error)]' : ''}`} onClick={() => void trash(f)}>
                  {bin ? <RotateCcw aria-hidden="true" size={16} /> : <Trash2 aria-hidden="true" size={16} />}{bin ? 'Restore' : 'Delete'}
                </button>
              </div>
            )}
          </FileActionsMenu>
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
          {!!files.length && (
            <div className="relative mx-1 my-2 flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-background-subtle)] text-[var(--color-text-muted)] transition focus-within:border-[var(--color-primary)] focus-within:bg-[var(--color-background-surface)] focus-within:ring-2 focus-within:ring-[var(--color-primary-muted)]">
              <Search aria-hidden="true" size={14} className="pointer-events-none absolute left-2.5" />
              <input
                type="search"
                aria-label="Search files"
                placeholder="Search files"
                className="min-w-0 w-full appearance-none rounded-lg bg-transparent py-2 pl-8 pr-3 text-xs text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-placeholder)]"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          )}
          {[
            ...(activeFiles.some(f => f.permission && f.permission !== 'owner') ? ['Shared with me'] : []),
            ...(activeFiles.some(f => f.favourite) ? ['Favourites'] : []),
          ].map(v => <button key={v} className={sidebarItem(view === v)} onClick={() => {
            setView(v); setQuery(''); setMenu('');
          }}>{v}</button>)}
          {flat && (
            <button className="block" onClick={() => setView('My Files')}>
              ← {view}
            </button>
          )}
          {loading && <p role="status">Loading files…</p>}
          {message && (
            <div role="alert">
              {message}{' '}
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
                    : true,
              )
              .filter((f) =>
                query
                  ? (f.name + ' ' + f.description).toLowerCase().includes(query.toLowerCase())
                  : flat || !f.parent_id,
              )
              .map(row)}
          </ul>
          <button className={sidebarItem()} onClick={() => {
            setView('My Files'); setForm({ kind: 'folder', parent: null });
          }}><span className="flex items-center gap-2.5"><span aria-hidden className="material-symbols-outlined text-[17px]">add</span><span>Add Files</span></span></button>
          {['Archive', 'Deleted Files'].map(v => <button key={v} className={sidebarItem(view === v)} onClick={() => {
            setView(v); setQuery(''); setMenu('');
          }}>{v}</button>)}
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
