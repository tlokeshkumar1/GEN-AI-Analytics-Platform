import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import api from '../services/api';
import { RecommendationReview } from '../components/RecommendationReview';
import { AnalyticsWidget } from '../components/AnalyticsWidget';
import { hasUsableWidgetResult } from '../services/widgetResult';
import type { AnalyticsDefinition, ExecutionResult } from '../services/semanticService';

vi.mock('../services/api', () => ({ default: { get: vi.fn(), post: vi.fn() }, getApiErrorMessage: (e: Error) => e.message }));
beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);
const definition: AnalyticsDefinition = {
  id: 'heat', title: 'Heat rate', kind: 'gauge', revision: 1, semantic_revision: 3,
  dataset_id: 'power', version: 2, status: 'approved', reviewer: 'alice',
  query_plan: { metric: 'heat_rate', aggregation: 'AVG' }, dependencies: ['heat_rate'], explanation: '',
};
const recommendations = [{ ...definition, definition, selected_by_default: true }];
const result = (data: Record<string, any>[]): ExecutionResult => ({ success: true, data, summary: {}, records_matched: data.length, execution_time_ms: 1, execution_backend: 'hana' });

it('calculates a missing preview using its saved plan and exact source, without publishing while loading', async () => {
  vi.mocked(api.get).mockResolvedValue({ data: [definition] });
  let resolve!: (value: any) => void;
  vi.mocked(api.post).mockReturnValue(new Promise(done => { resolve = done; }));
  render(<RecommendationReview recommendations={recommendations} />);
  await screen.findByText(/Calculating widget data/);
  expect(screen.getByRole('button', { name: 'Publish Heat rate' })).toHaveProperty('disabled', true);
  expect(screen.queryByText('NaN')).toBeNull();
  expect(screen.queryByText('N/A')).toBeNull();
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/insights/execute', definition.query_plan, expect.objectContaining({
    headers: { 'X-Dataset-Id': 'power', 'X-Dataset-Version': '2', 'X-Semantic-Revision': '3' }, signal: expect.any(AbortSignal),
  })));
  await act(async () => resolve({ data: result([{ heat_rate: 2400 }]) }));
  expect(screen.getByRole('img', { name: 'Heat rate' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Publish Heat rate' })).toHaveProperty('disabled', false);
});

it('shows calculation failures and blocks publication despite an earlier approval', async () => {
  vi.mocked(api.get).mockResolvedValue({ data: [definition] });
  vi.mocked(api.post).mockRejectedValue(new Error('Source table is unavailable'));
  render(<RecommendationReview recommendations={recommendations} />);
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Source table is unavailable');
  expect(screen.getByRole('button', { name: 'Publish Heat rate' })).toHaveProperty('disabled', true);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Publish Selected Widgets (0)' })).toHaveProperty('disabled', true));
});

it('does not render NaN from a legacy placeholder or treat it as publishable', () => {
  const invalid = result([{ heat_rate: 'N/A' }]);
  render(<AnalyticsWidget definition={definition} result={invalid} />);
  expect(screen.getByRole('alert').textContent).toContain('No numeric values');
  expect(screen.queryByRole('img')).toBeNull();
  expect(hasUsableWidgetResult(definition, invalid)).toBe(false);
});

it('rejects unsuitable pie and radar results without changing signed measures', () => {
  expect(hasUsableWidgetResult({ ...definition, kind: 'pie' }, result([{ heat_rate: -10 }, { heat_rate: 20 }]))).toBe(false);
  expect(hasUsableWidgetResult({ ...definition, kind: 'radar' }, result([{ heat_rate: 10 }, { heat_rate: 20 }]))).toBe(false);
  expect(hasUsableWidgetResult({ ...definition, kind: 'bar' }, result([{ heat_rate: -10 }, { heat_rate: 20 }]))).toBe(true);
});

it('cancels the old source request and ignores its result after switching datasets', async () => {
  const other = { ...definition, dataset_id: 'other' };
  const otherRecommendations = [{ ...other, definition: other, selected_by_default: true }];
  vi.mocked(api.get).mockImplementation(async (_url, config) => ({ data: [config?.headers?.['X-Dataset-Id'] === 'power' ? definition : other] }));
  let resolveOld!: (value: any) => void;
  vi.mocked(api.post).mockImplementation((_url, _plan, config) => config?.headers?.['X-Dataset-Id'] === 'power'
    ? new Promise(done => { resolveOld = done; }) : Promise.resolve({ data: result([{ heat_rate: 3200 }]) }));
  const { rerender } = render(<RecommendationReview recommendations={recommendations} />);
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const oldSignal = vi.mocked(api.post).mock.calls[0][2]?.signal;
  rerender(<RecommendationReview recommendations={otherRecommendations} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Publish Heat rate' })).toHaveProperty('disabled', false));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => resolveOld({ data: result([{ heat_rate: 9999 }]) }));
  expect(screen.queryByText('9,999')).toBeNull();
  expect(screen.getByText('3,200')).toBeTruthy();
});
