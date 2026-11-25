import { useState } from 'react';
import api from '../services/api';
import type { AnalyticsDefinition } from '../services/semanticService';
import { contentChanged, control, Dashboard, FileDialog, fileError, useFiles } from './ContentFiles';
import { FolderDestination } from './FolderDestination';

export function SaveDashboardDialog({ source, items = [], close, saved }: {
  source?: Dashboard; items?: AnalyticsDefinition[]; close: () => void; saved: (doc: Dashboard) => void;
}) {
  const { files, error: treeError } = useFiles();
  const [folder, setFolder] = useState(source?.parent_id || '');
  const [name, setName] = useState(source ? source.name + ' (copy)' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <FileDialog title={source ? 'Save dashboard as' : 'Save dashboard'} close={() => { if (!busy) close(); }}>
    <fieldset className="grid gap-3" disabled={busy}>
      <FolderDestination files={files} folder={folder} onChange={setFolder} />
      <label className="grid">Dashboard name<input autoFocus className={control} maxLength={120} value={name} onChange={e => setName(e.target.value)} /></label>
      <button className={control} disabled={!folder || !name.trim() || !!treeError} onClick={async () => {
        setBusy(true); setError('');
        try {
          const { data } = source
            ? await api.post('/content/files/' + source.id + '/duplicate', { kind: 'dashboard', name: name.trim(), parent_id: folder, description: source.description })
            : await api.post('/content/dashboards/save', { name: name.trim(), parent_id: folder, sources: items.map(({ id, revision, dataset_id, version, semantic_revision }) => ({ id, revision, dataset_id, version, semantic_revision })) });
          contentChanged(); saved(data);
        } catch (err) { setError(fileError(err)); } finally { setBusy(false); }
      }}>{busy ? 'Saving…' : 'Save dashboard'}</button>
    </fieldset>
    {(error || treeError) && <p role="alert">{error || treeError}</p>}
  </FileDialog>;
}
