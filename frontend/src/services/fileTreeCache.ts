import { useSyncExternalStore } from 'react';
import type { FileEntry } from '../components/ContentFiles';
import api, { getApiErrorMessage } from './api';

type Snapshot = { files: FileEntry[]; loading: boolean; error: string };
const empty: Snapshot = { files: [], loading: false, error: '' };
const entries = new Map<string, TreeEntry>();
const ttl = 30_000;

class TreeEntry {
  snapshot: Snapshot = { ...empty, loading: true };
  listeners = new Set<() => void>();
  controller?: AbortController;
  updated = 0;

  constructor(readonly key: string, readonly deleted: boolean, readonly archived: boolean) {}
  getSnapshot = () => this.snapshot;
  publish(snapshot: Snapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }
  subscribe = (listener: () => void) => {
    entries.set(this.key, this);
    this.listeners.add(listener);
    if (!this.controller && Date.now() - this.updated >= ttl) void this.load();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.controller?.abort();
        this.controller = undefined;
        entries.delete(this.key);
      }
    };
  };
  async load(force = false) {
    if (this.controller && !force) return;
    this.controller?.abort();
    const request = new AbortController();
    this.controller = request;
    this.publish({ ...this.snapshot, loading: true, error: '' });
    try {
      const { data } = await api.get<FileEntry[]>('/content/tree', {
        params: { deleted: this.deleted, archived: this.archived }, signal: request.signal,
      });
      if (!Array.isArray(data)) throw new Error('The file tree response is invalid.');
      if (!request.signal.aborted) {
        this.updated = Date.now();
        this.publish({ files: data, loading: false, error: '' });
      }
    } catch (error) {
      if (!request.signal.aborted) this.publish({ ...this.snapshot, loading: false, error: getApiErrorMessage(error, 'Could not load files.') });
    } finally {
      if (this.controller === request) this.controller = undefined;
    }
  }
}

window.addEventListener('content-files-changed', () => {
  entries.forEach(entry => { void entry.load(true); });
});

const subscribeEmpty = () => () => {};
const getEmpty = () => empty;

export function useFileTree(deleted = false, archived = false, enabled = true) {
  // Keep shared requests isolated across account/session changes.
  const account = sessionStorage.getItem('auth_user') || localStorage.getItem('auth_user') || '';
  const token = sessionStorage.getItem('auth_token') || localStorage.getItem('auth_token') || '';
  const key = JSON.stringify([account, token, deleted, archived]);
  let entry = enabled ? entries.get(key) : undefined;
  if (enabled && !entry) {
    entry = new TreeEntry(key, deleted, archived);
    entries.set(key, entry);
  }
  return useSyncExternalStore(entry?.subscribe || subscribeEmpty, entry?.getSnapshot || getEmpty);
}
