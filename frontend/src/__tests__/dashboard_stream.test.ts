import { afterEach, expect, it, vi } from 'vitest';
import api from '../services/api';
import { generateGenAiDashboardStream } from '../services/semanticService';

vi.mock('../services/api', () => ({ default: { post: vi.fn() }, streamingRequestHeaders: () => ({ 'X-Dataset-Version': '3' }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('surfaces backend stream errors without launching a second generation', async () => {
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"error","message":"Invalid dimension"}\n\n'));
    controller.close();
  } });
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, body });
  vi.stubGlobal('fetch', fetcher);
  await expect(generateGenAiDashboardStream({ prompt: 'one chart' })).rejects.toThrow('Invalid dimension');
  expect(api.post).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0][1].headers['X-Dataset-Version']).toBe('3');
});

it('rejects interrupted streams without silently rerunning the workflow', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.close(); } }) }));
  await expect(generateGenAiDashboardStream({ prompt: 'one KPI' })).rejects.toThrow('before completion');
  expect(api.post).not.toHaveBeenCalled();
});
