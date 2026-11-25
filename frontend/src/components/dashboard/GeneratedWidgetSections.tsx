import { publishable, usePublicationDestination } from '../PublishToFiles';
import React, { useEffect, useState } from 'react';
import { AnalyticsDefinition, ExecutionResult, getRecommendations, saveDefinition } from '../../services/semanticService';
import { AnalyticsWidget } from '../AnalyticsWidget';
import { getApiErrorMessage } from '../../services/api';

export interface GeneratedWidget {
  definition: AnalyticsDefinition;
  result: ExecutionResult;
  published?: boolean;
  source?: 'visual' | 'prompt' | 'data_options';
}

export function GeneratedWidgetSections({ widgets, onPublished, navigate = () => {} }: {
  widgets: GeneratedWidget[];
  onPublished: (ids: string[]) => void;
  navigate?: (path: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (widgets.length) document.getElementById('generated-results')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [widgets.length]);
  const { choose, destinationDialog } = usePublicationDestination(navigate, ids => {
    onPublished(ids); setSelected(prev => prev.filter(id => !ids.includes(id)));
  });
  const publish = async () => {
    setPublishing(true); setError('');
    try {
      const selectedDefinitions = widgets.filter(w => selected.includes(w.definition.id) && !w.published).map(w => w.definition);
      const stored = selectedDefinitions.some(d => !publishable(d)) ? await getRecommendations(true) : [];
      await choose(selectedDefinitions.map(d => stored.find(i => i.id === d.id && i.revision === d.revision &&
        i.dataset_id === d.dataset_id && i.version === d.version && i.semantic_revision === d.semantic_revision) || d));
    } catch (err) { setError(getApiErrorMessage(err, 'Could not load reviewed definitions.')); }
    finally { setPublishing(false); }
  };
  if (!widgets.length) return null;
  return <div id="generated-results" className="space-y-5 scroll-mt-20" aria-label="Generated results">
    {(['KPI Generation', 'Chart Generation'] as const).map((title, index) => {
      const group = widgets.filter(w => (['kpi', 'gauge'].includes(w.definition.kind)) === (index === 0));
      if (!group.length) return null;
      return <section key={title} aria-label={title} className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{title} ({group.length})</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {group.map(w => <article key={w.definition.id} className="p-4 space-y-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] shadow-[var(--shadow-2xs)]">
            <label className="flex items-start gap-2 text-xs font-semibold">
              <input type="checkbox" aria-label={`Select ${w.definition.title} for publishing`} disabled={publishing || w.published}
                checked={w.published || selected.includes(w.definition.id)} onChange={e => setSelected(prev => e.target.checked ? [...prev, w.definition.id] : prev.filter(id => id !== w.definition.id))} />
              <span>{w.definition.title}</span>
            </label>
            <p className="text-[10px] text-[var(--color-text-secondary)]">{w.definition.kind.toUpperCase()} ? {w.definition.dataset_name || w.definition.dataset_id}</p>
            <AnalyticsWidget definition={w.definition} result={w.result} showTable={false} isDashboard />
            {!publishable(w.definition) && <button type="button" disabled={publishing} onClick={async () => {
              setPublishing(true); setError('');
              try {
                const stored = await getRecommendations(true, w.definition.dataset_id);
                if (!stored.some(i => i.id === w.definition.id && i.version === w.definition.version && i.semantic_revision === w.definition.semantic_revision))
                  await saveDefinition(w.definition);
                setMessage('Saved. Review and approve in Widgets before publishing.');
              } catch (err) { setError(getApiErrorMessage(err, 'Could not save the definition for review.')); }
              finally { setPublishing(false); }
            }}>Save for review</button>}
            {w.published && <p className="text-xs text-[var(--color-success)]">Live on Dashboard</p>}
          </article>)}
        </div>
      </section>;
    })}
    {destinationDialog}
    {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    {message && <p role="status" className="text-xs text-[var(--color-success)]">{message}</p>}
    {message && <button type="button" onClick={() => navigate('widgets')}>Open Widgets</button>}
    <button type="button" disabled={publishing || !selected.length} onClick={() => void publish()}
      className="px-4 py-2 rounded-[var(--radius-element)] bg-[var(--color-primary)] text-white text-xs font-semibold disabled:opacity-50 cursor-pointer">
      {publishing ? 'Publishing...' : `Publish Selected Widgets (${selected.length})`}
    </button>
  </div>;
}
