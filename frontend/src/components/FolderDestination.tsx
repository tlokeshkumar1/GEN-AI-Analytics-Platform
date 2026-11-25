import { useState } from 'react';
import { Plus } from 'lucide-react';
import { FileEntry, FileForm, fileInput, fileLabel, filePath, fileSecondaryButton } from './ContentFiles';

export function FolderDestination({ files, folder, onChange, onCreatingChange, children }: {
  files: FileEntry[]; folder: string; onChange: (id: string) => void; onCreatingChange?: (creating: boolean) => void; children?: React.ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const folders = files.filter(f => f.kind === 'folder' && f.permission === 'owner');
  function setCreation(value: boolean) {
    setCreating(value);
    onCreatingChange?.(value);
  }
  return <div className="grid min-w-0 gap-3">
    <div className="flex flex-wrap items-end gap-2">
      <label className={`${fileLabel} min-w-0 flex-1`}>Folder
        <select className={fileInput} value={folder} onChange={e => onChange(e.target.value)}>
          <option value="">Choose folder</option>
          {folders.map(f => <option key={f.id} value={f.id}>{filePath(files, f)}</option>)}
        </select>
      </label>
      <button type="button" aria-label="+ New Folder" className={`${fileSecondaryButton} shrink-0`} disabled={creating} onClick={() => setCreation(true)}><Plus aria-hidden="true" size={16} />New folder</button>
    </div>
    {!folders.length && !creating && <p className="rounded-lg bg-[var(--color-background-subtle)] px-3 py-2.5 text-sm leading-relaxed text-[var(--color-text-muted)]">Create your first folder to organize this dashboard.</p>}
    {creating && <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-background-subtle)] p-4">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">New folder</h3>
      <FileForm embedded kind="folder" files={files} parent={null}
        close={() => setCreation(false)} saved={f => { onChange(f.id); setCreation(false); }} />
    </div>}
    {children}
  </div>;
}
