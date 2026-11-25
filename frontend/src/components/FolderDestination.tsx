import { useState } from 'react';
import { control, FileEntry, FileForm, filePath } from './ContentFiles';

export function FolderDestination({ files, folder, onChange, children }: {
  files: FileEntry[]; folder: string; onChange: (id: string) => void; children?: React.ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const folders = files.filter(f => f.kind === 'folder' && f.permission === 'owner');
  return <div className="grid gap-2">
    <div className="flex items-end gap-2">
      <label className="grid flex-1">Folder
        <select className={control} value={folder} onChange={e => onChange(e.target.value)}>
          <option value="">Choose folder</option>
          {folders.map(f => <option key={f.id} value={f.id}>{filePath(files, f)}</option>)}
        </select>
      </label>
      <button type="button" className={control} onClick={() => setCreating(true)}>+ New Folder</button>
    </div>
    {!folders.length && <p>No folders exist. Create a folder to continue.</p>}
    {creating && <FileForm embedded kind="folder" files={files} parent={null}
      close={() => setCreating(false)} saved={f => { onChange(f.id); setCreating(false); }} />}
    {children}
  </div>;
}
