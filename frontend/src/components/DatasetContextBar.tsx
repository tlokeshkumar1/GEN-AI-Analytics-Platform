import React, { useEffect, useState } from 'react';
import { getDatasets } from '../services/datasetService';
import { DatasetItem } from '../types/dataset';
import { selectedContext, selectContext } from '../services/executionContext';
import { getApiErrorMessage } from '../services/api';
import { getSemanticModels, SemanticModel } from '../services/semanticService';

export function DatasetContextBar() {
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [selection, setSelection] = useState(selectedContext);
  const [error, setError] = useState('');
  const [models, setModels] = useState<SemanticModel[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!selection) { setModels([]); return; }
    getSemanticModels(selection.datasetId, selection.version).then(items => { if (!cancelled) setModels(items); })
      .catch(err => { if (!cancelled) setError(getApiErrorMessage(err, 'Semantic revisions could not be loaded.')); });
    return () => { cancelled = true; };
  }, [selection?.datasetId, selection?.version, selection?.semanticRevision]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      setSelection(selectedContext());
      getDatasets().then(items => { if (!cancelled) { setDatasets(items); setError(''); } })
        .catch(err => { if (!cancelled) setError(getApiErrorMessage(err, 'Could not load datasets.')); });
    };
    refresh();
    window.addEventListener('dataset-context-changed', refresh);
    return () => { cancelled = true; window.removeEventListener('dataset-context-changed', refresh); };
  }, []);

  const dataset = datasets.find(d => d.id === selection?.datasetId);

  return (
    <div className="mx-3 sm:mx-6 mt-3 p-2.5 sm:p-3 bg-[var(--color-background-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] shadow-[var(--shadow-xs)] flex flex-wrap items-center gap-3 text-xs">
      <label className="flex items-center gap-2 font-medium text-[var(--color-text-secondary)]">
        <span>Dataset</span>
        <select
          aria-label="Analytics dataset"
          className="h-8 px-2.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-primary)] font-medium max-w-60 focus:border-[var(--color-primary)] transition-colors cursor-pointer"
          value={dataset?.id || ''}
          onChange={event => {
            const item = datasets.find(d => d.id === event.target.value);
            selectContext(item ? { datasetId: item.id, version: item.currentVersion || 1, semanticRevision: 1 } : null);
          }}
        >
          <option value="">Select a dataset</option>
          {datasets.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>

      {dataset && (
        <label className="flex items-center gap-2 font-medium text-[var(--color-text-secondary)]">
          <span>Version</span>
          <select
            aria-label="Analytics dataset version"
            className="h-8 px-2.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-primary)] font-medium focus:border-[var(--color-primary)] transition-colors cursor-pointer"
            value={selection?.version}
            onChange={e => selectContext({ ...selection!, version: Number(e.target.value) })}
          >
            {dataset.versions?.map(v => <option key={v.version} value={v.version}>v{v.version}</option>)}
          </select>
        </label>
      )}

      {dataset && (
        <label className="flex items-center gap-2 font-medium text-[var(--color-text-secondary)]">
          <span>Semantic revision</span>
          <select
            aria-label="Analytics semantic revision"
            className="h-8 px-2.5 rounded-[var(--radius-element)] border border-[var(--color-border)] bg-[var(--color-background-subtle)] hover:bg-[var(--color-background-muted)] text-[var(--color-text-primary)] font-medium focus:border-[var(--color-primary)] transition-colors cursor-pointer"
            value={selection?.semanticRevision}
            onChange={e => selectContext({ ...selection!, semanticRevision: Number(e.target.value) })}
          >
            {!models.some(m => m.revision === selection?.semanticRevision) && <option value={selection?.semanticRevision}>Review required</option>}
            {models.map(m => <option key={m.revision} value={m.revision}>{m.revision} · {m.status}</option>)}
          </select>
        </label>
      )}

      <span className="text-[11px] text-[var(--color-text-muted)] ml-auto">Requests use the selected version.</span>
      {error && <span role="alert" className="text-xs text-[var(--color-error)] font-medium">{error}</span>}
    </div>
  );
}
