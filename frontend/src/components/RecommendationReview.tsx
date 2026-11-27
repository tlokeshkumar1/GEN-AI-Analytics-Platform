import { useEffect, useState } from 'react';
import api, { getApiErrorMessage } from '../services/api';
import type { AnalyticsDefinition, ExecutionResult } from '../services/semanticService';
import { executePlan } from '../services/semanticService';
import { runWidgetTask } from '../services/widgetTaskQueue';
import { GeneratedWidgetSections, type GeneratedWidget } from './dashboard/GeneratedWidgetSections';

export interface RecommendedChartItem {
  id: string;
  title: string;
  kind: string;
  query_plan: Record<string, any>;
  explanation: string;
  selected_by_default: boolean;
  preview_value?: string;
  preview_rows?: Array<Record<string, any>>;
  preview_result?: ExecutionResult;
  definition?: AnalyticsDefinition;
}

export function RecommendationReview({ recommendations, datasetId, version, semanticRevision, disabled = false, navigate }: {
  recommendations: RecommendedChartItem[];
  datasetId?: string;
  version?: number;
  semanticRevision?: number;
  disabled?: boolean;
  navigate?: (path: string) => void;
}) {
  const [widgets, setWidgets] = useState<GeneratedWidget[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const source = recommendations.find(item => item.definition)?.definition;
  const sourceId = datasetId || source?.dataset_id;
  const sourceVersion = version || source?.version;
  const sourceRevision = semanticRevision || source?.semantic_revision;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(''); setWidgets([]);
    async function load() {
      try {
        if (disabled) return;
        if (!sourceId || !sourceVersion || !sourceRevision) throw new Error('The recommendation source is unavailable. Reopen the completed upload report to review it.');
        // Fetch the exact uploaded version, including any reviews made since the report was saved.
        const { data } = await api.get<AnalyticsDefinition[]>('/insights/recommendations', {
          signal: abort.signal,
          headers: { 'X-Dataset-Id': sourceId, 'X-Dataset-Version': String(sourceVersion), 'X-Semantic-Revision': String(sourceRevision) },
        });
        if (!Array.isArray(data)) throw new Error('Could not load saved recommendations.');
        const next = recommendations.map(rec => {
          const candidates = data.filter(def => def.id === (rec.definition?.id || rec.id) &&
            def.dataset_id === sourceId && def.version === sourceVersion && def.semantic_revision === sourceRevision &&
            (!rec.definition || def.revision === rec.definition.revision));
          const definition = candidates.sort((a, b) => b.revision - a.revision)[0];
          if (!definition) return undefined;
          const result: ExecutionResult = { success: false, status: 'loading', data: [], summary: {},
            records_matched: 0, execution_time_ms: 0, execution_backend: 'pending' };
          return { definition, result, saved: true, selectedByDefault: rec.selected_by_default } as GeneratedWidget;
        }).filter((widget): widget is GeneratedWidget => Boolean(widget));
        if (!abort.signal.aborted) {
          setWidgets(next);
          setLoading(false);
          if (next.length !== recommendations.length) setError('Some saved recommendations are unavailable. Reload recommendations or regenerate them in Build Your KPI.');
          const headers = { 'X-Dataset-Id': sourceId, 'X-Dataset-Version': String(sourceVersion), 'X-Semantic-Revision': String(sourceRevision) };
          await Promise.all(next.map(widget => runWidgetTask(async () => {
            if (abort.signal.aborted) return;
            let result: ExecutionResult;
            try {
              result = await executePlan(widget.definition.query_plan, headers, abort.signal);
              if (!result || typeof result.success !== 'boolean') throw new Error('The calculation returned no valid result.');
            } catch (err) {
              if (abort.signal.aborted) return;
              result = { success: false, status: 'execution_error', data: [], summary: {}, records_matched: 0,
                execution_time_ms: 0, execution_backend: 'engine', error: getApiErrorMessage(err, 'Could not calculate this widget. Reload recommendations to retry.') };
            }
            if (!abort.signal.aborted) setWidgets(previous => previous.map(item => item.definition.id === widget.definition.id && item.definition.revision === widget.definition.revision ? { ...item, result } : item));
          })));
        }
      } catch (err) {
        if (!abort.signal.aborted) setError(getApiErrorMessage(err, 'Could not load recommendations for review.'));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => abort.abort();
  }, [recommendations, sourceId, sourceVersion, sourceRevision, disabled, retry]);
  if (disabled) return <p className="text-sm text-[var(--color-text-secondary)]">Complete ingestion and semantic review before approving or publishing recommendations.</p>;
  return <div className="space-y-3">
    {loading && <p role="status" className="text-xs">Loading saved recommendations…</p>}
    {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    {!loading && <button type="button" className="text-xs underline" onClick={() => setRetry(value => value + 1)}>Reload recommendations</button>}
    {!loading && widgets.length > 0 && <GeneratedWidgetSections
      key={`${sourceId}:${sourceVersion}:${sourceRevision}:${retry}`}
      widgets={widgets} defaultSelected navigate={navigate}
      onDefinitionUpdated={(original, updated) => setWidgets(previous => previous.map(widget =>
        widget.definition.id === original.id && widget.definition.revision === original.revision
          ? { ...widget, definition: updated, saved: true } : widget))}
      onPublished={ids => setWidgets(previous => previous.map(widget => ids.includes(widget.definition.id) ? { ...widget, published: true } : widget))}
    />}
  </div>;
}
