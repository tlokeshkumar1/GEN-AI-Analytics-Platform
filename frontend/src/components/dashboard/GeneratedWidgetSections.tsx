import React, { useEffect, useState } from 'react';
import { AnalyticsDefinition, ExecutionResult } from '../../services/semanticService';
import { AnalyticsWidget } from '../AnalyticsWidget';
import api, { getApiErrorMessage } from '../../services/api';
import { invalidateDashboardCache } from '../../screens/ExecutiveDashboard';

export interface GeneratedWidget {
  definition: AnalyticsDefinition;
  result: ExecutionResult;
  published?: boolean;
  source?: 'visual' | 'prompt' | 'data_options';
}

export function GeneratedWidgetSections({ widgets, onPublished }: {
  widgets: GeneratedWidget[];
  onPublished: (ids: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (widgets.length) document.getElementById('generated-results')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [widgets.length]);
  const publish = async () => {
    setPublishing(true);
    setError('');
    setMessage('');
    try {
      const groups = new Map<string, GeneratedWidget[]>();
      for (const widget of widgets.filter(w => selected.includes(w.definition.id) && !w.published)) {
        const d = widget.definition;
        const key = JSON.stringify([d.dataset_id, d.version, d.semantic_revision]);
        groups.set(key, [...(groups.get(key) || []), widget]);
      }
      for (const group of groups.values()) {
        const source = group[0].definition;
        if (!source.dataset_id) throw new Error('Choose a dataset before publishing these widgets.');
        await api.post('/dashboard/publish-recommended', {
          title: 'Executive Analytics Dashboard',
          items: group.map(({ definition: d }) => ({ id: d.id, title: d.title, kind: d.kind, query_plan: d.query_plan })),
        }, { headers: {
          'X-Dataset-Id': source.dataset_id,
          ...(source.version ? { 'X-Dataset-Version': String(source.version) } : {}),
          'X-Semantic-Revision': String(source.semantic_revision),
        } });
        const ids = group.map(w => w.definition.id);
        onPublished(ids);
        setSelected(prev => prev.filter(id => !ids.includes(id)));
        invalidateDashboardCache();
        window.dispatchEvent(new Event('dashboard_updated'));
        setMessage('Selected widgets published alongside existing dashboard widgets.');
      }
    } catch (err) {
      setError(getApiErrorMessage(err, 'Could not publish the selected widgets.'));
    } finally { setPublishing(false); }
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
            {w.published && <p className="text-xs text-[var(--color-success)]">Live on Dashboard</p>}
          </article>)}
        </div>
      </section>;
    })}
    {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    {message && <p role="status" className="text-xs text-[var(--color-success)]">{message}</p>}
    <button type="button" disabled={publishing || !selected.length} onClick={() => void publish()}
      className="px-4 py-2 rounded-[var(--radius-element)] bg-[var(--color-primary)] text-white text-xs font-semibold disabled:opacity-50 cursor-pointer">
      {publishing ? 'Publishing...' : `Publish Selected Widgets (${selected.length})`}
    </button>
  </div>;
}
