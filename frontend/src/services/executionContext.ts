export interface DatasetContext {
  datasetId: string;
  version: number;
  semanticRevision: number;
}

const key = () => {
  try { return `dataset-context:${JSON.parse(localStorage.getItem('auth_user') || '{}').user_id || 'signed-out'}`; }
  catch { return 'dataset-context:signed-out'; }
};

export function selectedContext(): DatasetContext | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key()) || 'null');
    return value?.datasetId && Number.isInteger(value.version) && value.version > 0 ? value : null;
  } catch { return null; }
}

export function selectContext(value: DatasetContext | null) {
  if (value) sessionStorage.setItem(key(), JSON.stringify(value));
  else sessionStorage.removeItem(key());
  window.dispatchEvent(new Event('dataset-context-changed'));
}

export function contextHeaders(): Record<string, string> {
  const context = selectedContext();
  return context ? {
    'X-Dataset-Id': context.datasetId,
    'X-Dataset-Version': String(context.version),
    'X-Semantic-Revision': String(context.semanticRevision),
  } : {};
}

export async function ensureDefaultContext(): Promise<DatasetContext | null> {
  const existing = selectedContext();
  if (existing) return existing;
  try {
    const { getDatasets } = await import('./datasetService');
    const datasets = await getDatasets();
    if (!datasets || datasets.length === 0) return null;
    const active = datasets.find(d => d.isActive) || datasets[0];

    let revision = 1;
    try {
      const { getSemanticModels } = await import('./semanticService');
      const models = await getSemanticModels(active.id, active.currentVersion || 1);
      const approved = models.filter(m => m.status === 'approved');
      if (approved.length > 0) {
        revision = Math.max(...approved.map(m => m.revision));
      } else if (models.length > 0) {
        revision = Math.max(...models.map(m => m.revision));
      }
    } catch {
      revision = 1;
    }

    const defaultCtx: DatasetContext = {
      datasetId: active.id,
      version: active.currentVersion || 1,
      semanticRevision: revision,
    };
    selectContext(defaultCtx);
    return defaultCtx;
  } catch {
    return null;
  }
}

