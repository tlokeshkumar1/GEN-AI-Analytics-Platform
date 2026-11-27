import type { FileEntry } from '../components/ContentFiles';

export const personalRoute = (path: string) => path === 'my-files' || /^dashboards\/.+/.test(path);

function namedPath(files: FileEntry[], file: FileEntry): string | undefined {
  const names = [file.name];
  const seen = new Set([file.id]);
  let parent = file.parent_id;
  while (parent) {
    const folder = files.find(f => f.id === parent && f.kind === 'folder');
    if (!folder || seen.has(parent)) return undefined;
    seen.add(parent);
    names.unshift(folder.name);
    parent = folder.parent_id;
  }
  return 'dashboards/My_Files/' + names.map(name => encodeURIComponent(name.replace(/ /g, '_'))).join('/');
}

export function dashboardRoute(files: FileEntry[], id: string): string {
  const file = files.find(f => f.id === id && f.kind === 'dashboard');
  const path = file && namedPath(files, file);
  // Keep ambiguous names reachable by their existing unique identifier.
  if (!path || files.filter(f => f.kind === 'dashboard' && namedPath(files, f) === path).length !== 1) return 'dashboards/' + id;
  return path;
}

export function dashboardIdFromRoute(files: FileEntry[], route: string): string | undefined {
  const old = /^dashboards\/([a-f0-9]{32})$/.exec(route);
  if (old) return old[1];
  let normalized: string;
  try {
    normalized = route.replace(/\/+$/, '').split('/').map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
  } catch { return undefined; }
  const matches = files.filter(f => f.kind === 'dashboard' && namedPath(files, f) === normalized);
  return matches.length === 1 ? matches[0].id : undefined;
}
