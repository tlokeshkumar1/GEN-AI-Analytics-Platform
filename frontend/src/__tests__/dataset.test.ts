import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '../services/api';
import {
  getDatasets, getDatasetData, updateDatasetRows, appendDatasetData,
  deleteDatasetRows, deleteDataset, rollbackDataset, activateDataset,
  reindexDataset, previewAppendFile,
} from '../services/datasetService';
import { uploadDatasetFile } from '../services/uploadService';

vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

beforeEach(() => vi.resetAllMocks());

describe('Dataset API integration', () => {
  it('returns only backend datasets, including a genuinely empty list', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] });
    expect(await getDatasets()).toEqual([]);
    expect(api.get).toHaveBeenCalledWith('/datasets');
  });

  it('passes pagination, sort, search and real rows through to the API', async () => {
    const data = { dataset: { id: 'real' }, rows: [{ id: 'r1', Quantity: 7 }], totalRows: 1 };
    vi.mocked(api.get).mockResolvedValue({ data });
    expect(await getDatasetData('real', 2, 50, 'Quantity', 'desc', 'East')).toEqual(data);
    expect(api.get).toHaveBeenCalledWith('/datasets/real/data', {
      params: { page: 2, pageSize: 50, sortField: 'Quantity', sortDir: 'desc', search: 'East' },
    });
  });

  it('never replaces failed reads or mutations with mock data or fake success', async () => {
    const failure = new Error('Backend unavailable');
    vi.mocked(api.get).mockRejectedValue(failure);
    vi.mocked(api.post).mockRejectedValue(failure);
    vi.mocked(api.put).mockRejectedValue(failure);
    vi.mocked(api.delete).mockRejectedValue(failure);
    const requests = [
      getDatasets(), getDatasetData('real'), updateDatasetRows('real', [{ id: 'r1' }]),
      appendDatasetData('real', { rows: [{ id: 'r2' }] }), deleteDatasetRows('real', ['r1']),
      deleteDataset('real'), rollbackDataset('real', 1), activateDataset('real'), reindexDataset('real'),
    ];
    const results = await Promise.allSettled(requests);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
  });

  it('posts a rollback with the requested version and returns updated metadata', async () => {
    const data = { success: true, dataset: { id: 'real', currentVersion: 1 } };
    vi.mocked(api.post).mockResolvedValue({ data });
    expect(await rollbackDataset('real', 1)).toEqual(data);
    expect(api.post).toHaveBeenCalledWith('/datasets/real/rollback', { version: 1 });
  });

  it('sends uploaded append files once as multipart data', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { rowsAppended: 1 } });
    const file = new File(['Name,Value\nA,1'], 'add.csv', { type: 'text/csv' });
    await appendDatasetData('real', { file, rows: [] });
    const [url, body] = vi.mocked(api.post).mock.calls[0];
    expect(url).toBe('/datasets/real/append');
    expect((body as FormData).get('file')).toBe(file);
    expect((body as FormData).get('rows')).toBe('[]');
  });

  it('uses the server to preview binary spreadsheets', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { totalRows: 3, validRows: [] } });
    const file = new File(['binary'], 'add.xlsx');
    expect((await previewAppendFile('real', file)).totalRows).toBe(3);
    expect(vi.mocked(api.post).mock.calls[0][0]).toBe('/datasets/real/append/preview');
  });

  it('uploads files and returns the real embedding count and dataset version', async () => {
    const data = { status: 'success', rows_processed: 12, embeddings_generated: 2, version: 3 };
    vi.mocked(api.post).mockResolvedValue({ data });
    const file = new File(['a,b'], 'Sales.csv');
    expect(await uploadDatasetFile(file)).toEqual(data);
    expect(vi.mocked(api.post).mock.calls[0][0]).toBe('/upload');
  });
});
