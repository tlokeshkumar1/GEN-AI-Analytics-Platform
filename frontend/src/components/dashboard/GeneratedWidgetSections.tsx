import { publishable, usePublicationDestination } from '../PublishToFiles';
import React, { useEffect, useRef, useState } from 'react';
import { AnalyticsDefinition, ExecutionResult, getRecommendations, reviewDefinition, saveDefinition } from '../../services/semanticService';
import { AnalyticsWidget } from '../AnalyticsWidget';
import { getApiErrorMessage } from '../../services/api';
import { runWidgetTask } from '../../services/widgetTaskQueue';
import { hasUsableWidgetResult } from '../../services/widgetResult';

export interface GeneratedWidget {
  definition: AnalyticsDefinition;
  result: ExecutionResult;
  published?: boolean;
  source?: 'visual' | 'prompt' | 'data_options';
  saved?: boolean;
  selectedByDefault?: boolean;
}

const sourceKey = (d: AnalyticsDefinition) => JSON.stringify([d.dataset_id, d.version, d.semantic_revision, d.id]);

export function GeneratedWidgetSections({ widgets, onPublished, onDefinitionUpdated, navigate = () => {}, defaultSelected = false, disabled = false }: {
  widgets: GeneratedWidget[];
  onPublished: (ids: string[]) => void;
  navigate?: (path: string) => void;
  onDefinitionUpdated?: (original: AnalyticsDefinition, updated: AnalyticsDefinition) => void;
  defaultSelected?: boolean;
  disabled?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>(() => defaultSelected ? widgets.filter(w => !w.published && w.selectedByDefault !== false && w.definition.status !== 'rejected').map(w => sourceKey(w.definition)) : []);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reviewing, setReviewing] = useState<Record<string, 'approved' | 'rejected'>>({});
  const pending = useRef(new Set<string>());
  const resultsSurface = useRef<HTMLDivElement>(null);
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const [updates, setUpdates] = useState<Record<string, { original: AnalyticsDefinition; definition: AnalyticsDefinition }>>({});
  const visibleWidgets = widgets.map(w => {
    const update = updates[sourceKey(w.definition)];
    return update?.original === w.definition ? { ...w, definition: update.definition, saved: true } : w;
  });
  useEffect(() => {
    if (widgets.length) resultsSurface.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [widgets.length]);
  useEffect(() => {
    setSelected(previous => {
      const next = previous.filter(key => widgets.some(w => sourceKey(w.definition) === key &&
        (w.result.status === 'loading' || hasUsableWidgetResult(w.definition, w.result))));
      return next.length === previous.length ? previous : next;
    });
  }, [widgets]);
  const { choose, destinationDialog } = usePublicationDestination(navigate, ids => {
    onPublished(ids);
    setSelected(prev => prev.filter(key => !visibleWidgets.some(w => sourceKey(w.definition) === key && ids.includes(w.definition.id))));
  });
  const review = async (widget: GeneratedWidget, decision: 'approved' | 'rejected') => {
    if (disabled || (decision === 'approved' && !hasUsableWidgetResult(widget.definition, widget.result))) return;
    const original = widget.definition;
    const key = sourceKey(original);
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setError('');
    setReviewing(prev => ({ ...prev, [key]: decision }));
    setReviewErrors(prev => { const next = { ...prev }; delete next[key]; return next; });
    let previousDefinition = original;
    const remember = (definition: AnalyticsDefinition) => {
      const source = widgets.find(w => sourceKey(w.definition) === key)?.definition || original;
      setUpdates(prev => ({ ...prev, [key]: { original: source, definition } }));
      onDefinitionUpdated?.(previousDefinition, definition);
      previousDefinition = definition;
    };
    try { await runWidgetTask(async () => {
      if (!original.dataset_id || !original.version || !original.semantic_revision) throw new Error('Select the source dataset and regenerate this widget before reviewing it.');
      let stored = original;
      if (!widget.saved && !publishable(original)) {
        stored = { ...original, ...await saveDefinition(original) };
        remember(stored);
      }
      const updated = { ...stored, ...await reviewDefinition(stored, decision) };
      remember(updated);
      if (decision === 'rejected') setSelected(prev => prev.filter(value => value !== key));
      setMessage(`${decision === 'approved' ? 'Approved' : 'Rejected'} "${original.title}".${decision === 'approved' ? ' Ready to publish.' : ''}`);
    });
    } catch (err) {
      setReviewErrors(prev => ({ ...prev, [key]: getApiErrorMessage(err, `Could not ${decision === 'approved' ? 'approve' : 'reject'} the widget.`) }));
    } finally {
      pending.current.delete(key);
      setReviewing(prev => { const next = { ...prev }; delete next[key]; return next; });
    }
  };
  const reviewSelected = (decision: 'approved' | 'rejected') => {
    visibleWidgets.filter(w => selected.includes(sourceKey(w.definition)) && !w.published &&
      (decision === 'rejected' || hasUsableWidgetResult(w.definition, w.result)) &&
      (w.definition.status === 'proposed' || (decision === 'approved' && w.definition.status === 'approved' && w.definition.reviewer === 'system'))
    ).forEach(w => { void review(w, decision); });
  };
  const publish = async (definitions?: AnalyticsDefinition[]) => {
    if (publishing || disabled) return;
    setPublishing(true); setError('');
    try {
      const selectedDefinitions = definitions || visibleWidgets.filter(w => selected.includes(sourceKey(w.definition)) && !w.published).map(w => w.definition);
      if (selectedDefinitions.some(d => !visibleWidgets.some(w => sourceKey(w.definition) === sourceKey(d) &&
        w.definition.revision === d.revision && hasUsableWidgetResult(w.definition, w.result)))) {
        throw new Error('Wait for valid widget data before publishing. Reload failed recommendations to retry.');
      }
      // Resolve external reviews without losing the exact source/version reference.
      const stored = selectedDefinitions.some(d => !publishable(d)) ? await getRecommendations(true) : [];
      const resolved = selectedDefinitions.map(d => stored.find(i => i.id === d.id && i.revision === d.revision &&
        i.dataset_id === d.dataset_id && i.version === d.version && i.semantic_revision === d.semantic_revision) || d);
      if (!resolved.length || resolved.some(d => !publishable(d))) throw new Error('Approve the selected widgets using the Approve button on each card before publishing.');
      await choose(resolved);
    } catch (err) { setError(getApiErrorMessage(err, 'Could not load reviewed definitions.')); }
    finally { setPublishing(false); }
  };
  if (!widgets.length) return null;
  return <div ref={resultsSurface} className="space-y-5 scroll-mt-20" aria-label="Generated results">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={disabled} onClick={() => setSelected(visibleWidgets.filter(w => !w.published && w.definition.status !== 'rejected' && hasUsableWidgetResult(w.definition, w.result)).map(w => sourceKey(w.definition)))} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs">Select all</button>
      <button type="button" onClick={() => setSelected([])} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs">Clear selection</button>
      <button type="button" disabled={disabled || !visibleWidgets.some(w => selected.includes(sourceKey(w.definition)) && !reviewing[sourceKey(w.definition)] && hasUsableWidgetResult(w.definition, w.result) && (w.definition.status === 'proposed' || w.definition.reviewer === 'system'))} onClick={() => reviewSelected('approved')} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">Approve selected</button>
      <button type="button" disabled={disabled || !visibleWidgets.some(w => selected.includes(sourceKey(w.definition)) && !reviewing[sourceKey(w.definition)] && w.definition.status === 'proposed')} onClick={() => reviewSelected('rejected')} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">Reject selected</button>
      {Object.keys(reviewing).length > 0 && <span role="status" className="text-xs text-[var(--color-text-secondary)]">{Object.keys(reviewing).length} review operation(s) in progress</span>}
    </div>
    {(['KPI Generation', 'Chart Generation'] as const).map((title, index) => {
      const group = visibleWidgets.filter(w => (['kpi', 'gauge'].includes(w.definition.kind)) === (index === 0));
      if (!group.length) return null;
      return <section key={title} aria-label={title} className="space-y-3">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{title} ({group.length})</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {group.map(w => <article key={sourceKey(w.definition)} className="min-w-0 p-4 space-y-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] shadow-[var(--shadow-2xs)]">
            <label className="flex items-start gap-2 text-xs font-semibold">
              <input type="checkbox" aria-label={`Select ${w.definition.title} for publishing`} disabled={disabled || !hasUsableWidgetResult(w.definition, w.result) || Boolean(reviewing[sourceKey(w.definition)]) || w.published || w.definition.status === 'rejected'}
                checked={w.published || selected.includes(sourceKey(w.definition))} onChange={e => setSelected(prev => e.target.checked ? [...prev, sourceKey(w.definition)] : prev.filter(key => key !== sourceKey(w.definition)))} />
              <span className="min-w-0 break-words">{w.definition.title}</span>
            </label>
            <p className="break-all text-[10px] text-[var(--color-text-secondary)]">{w.definition.kind.replace(/_/g, ' ').toUpperCase()} · {w.definition.dataset_name || w.definition.dataset_id}</p>
            <AnalyticsWidget definition={w.definition} result={w.result} showTable={false} isDashboard />
            <p className="text-xs font-medium text-[var(--color-text-secondary)]">{w.definition.status === 'approved' ? 'Approved' : w.definition.status === 'rejected' ? 'Rejected' : 'Awaiting review'}</p>
            <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
              <button type="button" aria-label={`${w.definition.status === 'approved' && w.definition.reviewer !== 'system' ? 'Approved' : 'Approve'} ${w.definition.title}`} disabled={disabled || !hasUsableWidgetResult(w.definition, w.result) || Boolean(reviewing[sourceKey(w.definition)]) || w.published || (w.definition.status !== 'proposed' && !(w.definition.status === 'approved' && w.definition.reviewer === 'system'))}
                onClick={() => void review(w, 'approved')} className="rounded-[var(--radius-element)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">
                {reviewing[sourceKey(w.definition)] === 'approved' ? 'Approving…' : w.definition.status === 'approved' && w.definition.reviewer !== 'system' ? 'Approved' : 'Approve'}
              </button>
              <button type="button" aria-label={`Reject ${w.definition.title}`} disabled={disabled || Boolean(reviewing[sourceKey(w.definition)]) || w.published || w.definition.status !== 'proposed'}
                onClick={() => void review(w, 'rejected')} className="rounded-[var(--radius-element)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium disabled:opacity-50">
                {reviewing[sourceKey(w.definition)] === 'rejected' ? 'Rejecting…' : 'Reject'}
              </button>
              <button type="button" aria-label={`Publish ${w.definition.title}`} disabled={disabled || publishing || Boolean(reviewing[sourceKey(w.definition)]) || w.published || !publishable(w.definition) || !hasUsableWidgetResult(w.definition, w.result)}
                onClick={() => void publish([w.definition])} className="rounded-[var(--radius-element)] bg-[var(--color-primary)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Publish</button>
            </div>
            {reviewErrors[sourceKey(w.definition)] && <p role="alert" className="text-xs text-[var(--color-danger)]">{reviewErrors[sourceKey(w.definition)]}</p>}
            {w.published && <p className="text-xs text-[var(--color-success)]">Live on Dashboard</p>}
          </article>)}
        </div>
      </section>;
    })}
    {destinationDialog}
    {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    {message && <p role="status" className="text-xs text-[var(--color-success)]">{message}</p>}
    {selected.length > 0 && visibleWidgets.some(w => selected.includes(sourceKey(w.definition)) && !publishable(w.definition)) && <p className="text-xs text-[var(--color-text-secondary)]">Approve the selected widgets on their cards before publishing.</p>}
    <button type="button" disabled={disabled || publishing || !selected.length || visibleWidgets.some(w => selected.includes(sourceKey(w.definition)) && (!publishable(w.definition) || !hasUsableWidgetResult(w.definition, w.result) || Boolean(reviewing[sourceKey(w.definition)])))} onClick={() => void publish()}
      className="px-4 py-2 rounded-[var(--radius-element)] bg-[var(--color-primary)] text-white text-xs font-semibold disabled:opacity-50 cursor-pointer">
      {publishing ? 'Publishing...' : `Publish Selected Widgets (${selected.length})`}
    </button>
  </div>;
}
