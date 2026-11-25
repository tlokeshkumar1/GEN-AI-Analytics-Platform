import { useRef, useState } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import api from '../services/api';
import type { AnalyticsDefinition } from '../services/semanticService';
import { contentChanged, Dashboard, FileDialog, fileError, fileInput, fileLabel, filePrimaryButton, fileSecondaryButton, useFiles } from './ContentFiles';
import { FolderDestination } from './FolderDestination';

export function SaveDashboardDialog({ source, items = [], close, saved }: {
  source?: Dashboard; items?: AnalyticsDefinition[]; close: () => void; saved: (doc: Dashboard) => void;
}) {
  const { files, error: treeError, loading } = useFiles();
  const [folder, setFolder] = useState(source?.parent_id || '');
  const [name, setName] = useState(source ? source.name + ' (copy)' : '');
  const [busy, setBusy] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const canSave = !!folder && !!name.trim() && !treeError && !loading && !creatingFolder;

  async function save() {
    if (saving.current || !canSave) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const { data } = source
        ? await api.post('/content/files/' + source.id + '/duplicate', { kind: 'dashboard', name: name.trim(), parent_id: folder, description: source.description })
        : await api.post('/content/dashboards/save', { name: name.trim(), parent_id: folder, sources: items.map(({ id, revision, dataset_id, version, semantic_revision }) => ({ id, revision, dataset_id, version, semantic_revision })) });
      contentChanged();
      saved(data);
    } catch (err) {
      setError(fileError(err));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return <FileDialog title={source ? 'Save dashboard as' : 'Save dashboard'} busy={busy} close={() => { if (!saving.current) close(); }}>
    <p className="-mt-2 mb-5 text-sm leading-relaxed text-[var(--color-text-muted)]">Choose a folder and give your dashboard a name.</p>
    <fieldset className="grid min-w-0 gap-5" disabled={busy}>
      {loading
        ? <p role="status" className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><LoaderCircle aria-hidden="true" size={16} className="animate-spin motion-reduce:animate-none" />Loading folders...</p>
        : <FolderDestination files={files} folder={folder} onChange={setFolder} onCreatingChange={setCreatingFolder} />}
      <label className={fileLabel}>Dashboard name<input autoFocus disabled={busy} className={fileInput} placeholder="e.g. Project overview" maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
      {(error || treeError) && <p role="alert" className="rounded-lg bg-[var(--color-error-soft)] px-3 py-2.5 text-sm leading-relaxed text-[var(--color-error)]">{error || treeError}</p>}
      <div className="mt-1 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] pt-4">
        <button type="button" className={fileSecondaryButton} onClick={close}>Cancel</button>
        <button type="button" className={filePrimaryButton} disabled={!canSave || busy} onClick={() => void save()}>
          {busy ? <LoaderCircle aria-hidden="true" size={16} className="shrink-0 animate-spin motion-reduce:animate-none" /> : <Save aria-hidden="true" size={16} />}
          <span role={busy ? 'status' : undefined}>{busy ? 'Saving dashboard...' : 'Save dashboard'}</span>
        </button>
      </div>
    </fieldset>
  </FileDialog>;
}
