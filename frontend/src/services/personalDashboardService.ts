import api from './api';
import type { AnalyticsDefinition, ExecutionResult } from './semanticService';
import type { ScopedFilters } from '../components/PlacementFilters';

export type DashboardValue = {
  definition: AnalyticsDefinition;
  result: ExecutionResult;
  filters: ScopedFilters;
  filter_fields: string[];
} | { error: string };

export async function refreshPersonalDashboard(
  id: string, pageId: string, revision: number, signal: AbortSignal,
  onWidget: (id: string, value: DashboardValue) => void, force = false,
) {
  let consumed = 0;
  let complete = false;
  let streamError: Error | undefined;
  const consume = (text: string, final = false) => {
    if (signal.aborted || streamError) return;
    try {
      let end: number;
      while ((end = text.indexOf('\n', consumed)) !== -1 || (final && consumed < text.length)) {
        if (end === -1) end = text.length;
        const line = text.slice(consumed, end).trim();
        consumed = end + 1;
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.revision !== revision) throw new Error('Dashboard changed. Refresh to view the latest layout.');
        if (event.type === 'widget') onWidget(event.id, event.value);
        if (event.type === 'complete') complete = true;
      }
    } catch (error) {
      streamError = error instanceof Error ? error : new Error('Could not read dashboard results.');
    }
  };
  const { data } = await api.post('/content/files/' + id + '/refresh', null, {
    params: { page_id: pageId, stream: true, force }, signal, responseType: 'text',
    onDownloadProgress: progress => {
      const text = progress.event?.target?.responseText;
      if (typeof text === 'string') consume(text);
    },
  });
  if (signal.aborted) return;
  if (typeof data === 'string') {
    consume(data, true);
    if (streamError) throw streamError;
    if (!complete) throw new Error('Dashboard loading was interrupted. Refresh to retry.');
  } else {
    // Compatibility with JSON responses from older API instances.
    if (data.revision !== revision) throw new Error('Dashboard changed. Refresh to view the latest layout.');
    Object.entries(data.widgets as Record<string, DashboardValue>).forEach(([key, value]) => onWidget(key, value));
  }
}
