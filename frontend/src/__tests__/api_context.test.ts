import { expect, it, vi } from 'vitest';
import api, { getApiErrorMessage } from '../services/api';
import { AxiosError } from 'axios';

vi.mock('../services/executionContext', () => ({
  contextHeaders: () => ({ 'X-Dataset-Id': 'active-dataset', 'X-Dataset-Version': '7', 'X-Semantic-Revision': '2' }),
}));

it('keeps explicit dataset and version headers when previewing or publishing a pinned generation', async () => {
  const response = await api.get('/verification', {
    headers: { 'X-Dataset-Id': 'generated-dataset', 'X-Dataset-Version': '3', 'X-Semantic-Revision': '1' },
    adapter: async config => ({ data: config.headers.toJSON(), status: 200, statusText: 'OK', headers: {}, config }),
  });
  expect(response.data['X-Dataset-Id']).toBe('generated-dataset');
  expect(response.data['X-Dataset-Version']).toBe('3');
  expect(response.data['X-Semantic-Revision']).toBe('1');
});

it('continues supplying the selected context for ordinary API requests', async () => {
  const response = await api.get('/verification', {
    adapter: async config => ({ data: config.headers.toJSON(), status: 200, statusText: 'OK', headers: {}, config }),
  });
  expect(response.data['X-Dataset-Id']).toBe('active-dataset');
  expect(response.data['X-Dataset-Version']).toBe('7');
});

it('does not inherit a version or semantic revision from a different dataset', async () => {
  const response = await api.get('/verification', {
    headers: { 'X-Dataset-Id': 'another-dataset' },
    adapter: async config => ({ data: config.headers.toJSON(), status: 200, statusText: 'OK', headers: {}, config }),
  });
  expect(response.data['X-Dataset-Id']).toBe('another-dataset');
  expect(response.data['X-Dataset-Version']).toBeUndefined();
  expect(response.data['X-Semantic-Revision']).toBeUndefined();
});

it('shows the validation field and reason for a 422 response', () => {
  const error = new AxiosError('Request failed with status code 422');
  error.response = { status: 422, data: { detail: [{ loc: ['body', 'chart_type'], msg: "Input should be a supported chart type" }] } } as any;
  expect(getApiErrorMessage(error, 'Failed')).toBe('chart_type: Input should be a supported chart type');
});
