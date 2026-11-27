import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { DatasetIndexStatus, DatasetStatusBadge } from '../components/dataset/DatasetStatusBadge';
import type { DatasetItem } from '../types/dataset';

afterEach(cleanup);

it('shows the saved provider error and retained progress without a misleading sync spinner', () => {
  const dataset = {
    embeddingStatus: 'Error', hanaSyncStatus: 'Pending', embeddingCount: 32,
    embeddingTotal: 3650, rowCount: 3650,
    embeddingError: 'The embedding provider failed (HTTP 500). Request ID: req-123.',
  } as DatasetItem;
  const { container } = render(<DatasetIndexStatus dataset={dataset} />);
  expect(screen.getByText('HANA: Waiting for embeddings')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('HTTP 500');
  expect(screen.getByRole('alert').textContent).toContain('32 of 3650 vectors retained');
  expect(screen.queryByText('HANA: Syncing…')).toBeNull();
  expect(container.querySelector('.animate-spin')).toBeNull();
});

it('renders a persisted blocked status without implying that relational storage failed', () => {
  render(<DatasetStatusBadge type="hana" status="Blocked" />);
  expect(screen.getByRole('status').getAttribute('title')).toContain('uploaded table data remains saved');
  expect(screen.queryByText('HANA: Offline')).toBeNull();
});

it('clears the error display after a successful retry', () => {
  const dataset = { embeddingStatus: 'Ready', hanaSyncStatus: 'Ready', embeddingCount: 3650, embeddingError: null } as DatasetItem;
  render(<DatasetIndexStatus dataset={dataset} />);
  expect(screen.getByText('Embeddings: Ready (3650)')).toBeTruthy();
  expect(screen.getByText('HANA: Synced')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});
