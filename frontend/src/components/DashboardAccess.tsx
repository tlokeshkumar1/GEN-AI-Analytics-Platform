import { useEffect, useState } from 'react';
import api from '../services/api';
import { contentChanged, control, Dashboard, FileDialog, fileError } from './ContentFiles';

export function DashboardAccess({
  doc,
  close,
  history,
}: {
  doc: Dashboard;
  close: () => void;
  history: boolean;
}) {
  const [users, setUsers] = useState<string[]>([]);
  const [recipient, setRecipient] = useState('');
  const [grant, setGrant] = useState('view');
  const [revisions, setRevisions] = useState<
    { action: string; document: Dashboard & { modified_by: string; updated_at: string } }[]
  >([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const path = '/content/files/' + doc.id;
  useEffect(() => {
    const controller = new AbortController();
    api
      .get(history ? path + '/history' : '/content/users', { signal: controller.signal })
      .then(({ data }) => {
        if (history) setRevisions(data);
        else setUsers(data);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(fileError(err));
      });
    return () => controller.abort();
  }, [path, history]);
  async function save(url: string, fields: Record<string, unknown>) {
    setBusy(true);
    try {
      await api.post(path + url, { revision: doc.revision, ...fields });
      close();
      contentChanged();
    } catch (err) {
      setError(fileError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <FileDialog title={history ? 'Revision history' : 'Manage dashboard access'} close={close}>
      {history ? (
        <ul className="max-h-80 overflow-y-auto">
          {revisions
            .sort((a, b) => b.document.revision - a.document.revision)
            .map((r) => (
              <li key={r.document.revision} className="mb-3">
                Revision {r.document.revision} · {r.action} · {r.document.name}
                <br />
                <small>
                  {r.document.modified_by} · {new Date(r.document.updated_at).toLocaleString()}
                </small>{' '}
                {r.document.revision !== doc.revision && (
                  <button
                    disabled={busy}
                    className={control}
                    onClick={() => {
                      if (window.confirm('Restore this layout and metadata as a new revision?'))
                        void save('/history/' + r.document.revision + '/restore', {});
                    }}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
        </ul>
      ) : (
        <div className="grid gap-3">
          <label>
            Workspace user
            <select
              className={control + ' w-full'}
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
            >
              <option value="">Select user</option>
              {users.map((u) => (
                <option key={u} value={u}>
                  {u}
                  {doc.grants?.[u] ? ' · ' + doc.grants[u] : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            Permission{' '}
            <select className={control} value={grant} onChange={(e) => setGrant(e.target.value)}>
              <option value="view">View</option>
              <option value="edit">Edit</option>
              <option value="revoke">Revoke access</option>
            </select>
          </label>
          <button
            disabled={!recipient || busy}
            className={control}
            onClick={() => void save('/access', { recipient, permission: grant })}
          >
            Save access
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </FileDialog>
  );
}
