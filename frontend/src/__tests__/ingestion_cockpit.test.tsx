import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../services/api';
import { AIAgentIngestionStepper, IngestionResult } from '../components/AIAgentIngestionStepper';
import { selectedContext } from '../services/executionContext';
import { uploadDatasetFileStream } from '../services/uploadService';

vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AIAgentIngestionStepper sequential stages & first-upload publish', () => {
  it('keeps failed storage visible and blocks publication of partial imports', () => {
    render(
      <AIAgentIngestionStepper
        isOpen
        isProcessing={false}
        filename="Projects.csv"
        result={{
          filename: 'Projects.csv', status: 'partial', ready_for_publication: false,
          warnings: ['The dataset was saved, but storage synchronization needs a retry.'],
          cloud_table: { table_name: 'PROJECTS', success: false },
          recommendations: [{ id: 'one', title: 'Count', kind: 'kpi', query_plan: {}, explanation: '', selected_by_default: true }],
        }}
        onClose={vi.fn()}
        onNavigateToDashboard={vi.fn()}
      />
    );
    expect(screen.getByText('Storage synchronization failed')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('storage synchronization needs a retry');
    expect((screen.getByRole('button', { name: /Publish on Dashboard/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('shows only one running stage at a time while subsequent stages remain Queued', () => {
    render(
      <AIAgentIngestionStepper
        isOpen
        isProcessing
        filename="Projects.xlsx"
        result={null}
        partialResult={{
          preprocessing_audit: {
            rows_before: 23,
            rows_after: 23,
            duplicates_removed: 0,
            null_values_cleaned: 93,
          },
        }}
        stageStatuses={{ 1: 'completed', 2: 'running', 3: 'queued', 4: 'queued' }}
        onClose={vi.fn()}
        onNavigateToDashboard={vi.fn()}
      />
    );

    expect(screen.getByText('Cleaned (23 rows)')).toBeTruthy();
    expect(screen.getByText('Reasoning over 5 rows…')).toBeTruthy();
    expect(screen.queryByText('Provisioning HANA…')).toBeNull();
    expect(screen.queryByText('Formulating charts…')).toBeNull();
    expect(screen.getAllByText('Queued')).toHaveLength(2);
  });

  it('selects the uploaded dataset and requires a destination before publishing', async () => {
    vi.mocked(api.get).mockImplementation(async url => ({ data: url.includes('/recommendations') ? [{ id: 'rec_1', title: 'Total Open Issues', kind: 'kpi', revision: 1, semantic_revision: 1, dataset_id: 'ds-first-upload', version: 1, status: 'approved', reviewer: 'alice' }] : [] }));
    vi.mocked(api.post).mockResolvedValue({ data: { status: 'success' } });
    const onClose = vi.fn();
    const onNavigateToDashboard = vi.fn();
    const onNavigateToBuildKpi = vi.fn();

    const result: IngestionResult = {
      filename: 'Projects.xlsx',
      rows_processed: 23,
      domain: 'Enterprise',
      version: 1,
      dataset: { id: 'ds-first-upload', currentVersion: 1 },
      preprocessing_audit: { rows_before: 23, rows_after: 23, duplicates_removed: 0, null_values_cleaned: 93 },
      cloud_table: { table_name: 'SAP_PROJECT_PROJECTS', rows_inserted: 23, success: true },
      recommendations: [
        {
          id: 'rec_1',
          title: 'Total Open Issues',
          kind: 'kpi',
          query_plan: { metric: 'OpenIssues', aggregation: 'SUM' },
          explanation: 'Tracks total open issues.',
          selected_by_default: true,
          preview_value: '18',
        },
      ],
    };

    render(
      <AIAgentIngestionStepper
        isOpen
        isProcessing={false}
        filename="Projects.xlsx"
        result={result}
        onClose={onClose}
        onNavigateToDashboard={onNavigateToDashboard}
        onNavigateToBuildKpi={onNavigateToBuildKpi}
      />
    );

    await waitFor(() => {
      expect(selectedContext()).toEqual({
        datasetId: 'ds-first-upload',
        version: 1,
        semanticRevision: 1,
      });
    });

    expect(screen.getByRole('button', { name: /Build Your KPI/i })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Publish on Dashboard \(1\)/i }));

    expect(await screen.findByRole('dialog', { name: 'Publish to dashboard' })).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onNavigateToDashboard).not.toHaveBeenCalled();
  });

  it('streams sequential SSE stage events and returns final UploadResponse', async () => {
    const sseBody = [
      'data: {"type":"request_started","filename":"Projects.xlsx"}\n\n',
      'data: {"type":"stage","stage":1,"status":"running","message":"Agent 1"}\n\n',
      'data: {"type":"stage","stage":1,"status":"completed","message":"Done 1","data":{"rows_processed":23}}\n\n',
      'data: {"type":"stage","stage":2,"status":"running","message":"Agent 2"}\n\n',
      'data: {"type":"result","data":{"status":"success","filename":"Projects.xlsx","rows_processed":23,"embeddings_generated":23,"message":"OK"}}\n\n',
      'data: {"type":"request_completed"}\n\n',
    ].join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sseBody));
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      )
    );

    const stages: Array<{ stage: number; status: string }> = [];
    const file = new File(['a,b\n1,2'], 'Projects.xlsx');
    const res = await uploadDatasetFileStream(file, undefined, undefined, undefined, evt => {
      stages.push({ stage: evt.stage, status: evt.status });
    });

    expect(stages).toEqual([
      { stage: 1, status: 'running' },
      { stage: 1, status: 'completed' },
      { stage: 2, status: 'running' },
    ]);
    expect(res.filename).toBe('Projects.xlsx');
    expect(res.rows_processed).toBe(23);
  });
});

