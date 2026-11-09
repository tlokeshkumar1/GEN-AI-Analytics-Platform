import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import api from '../services/api';
import { GraphStudio } from '../screens/GraphStudio';
import { RAGChat } from '../screens/RAGChat';
import { selectContext, selectedContext } from '../services/executionContext';

vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: (error: Error, fallback: string) => error.message || fallback,
}));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const DATASET_A = {
  id: 'ds_orders',
  name: 'Orders Table',
  description: 'Orders dataset',
  rowCount: 1200,
  columnCount: 3,
  lastUpdated: new Date().toISOString(),
  format: 'csv' as const,
  source: 'upload',
  status: 'Ready' as const,
  currentVersion: 1,
  isActive: true,
  columns: [
    { name: 'OrderId', type: 'identifier' as const },
    { name: 'OrderRevenue', type: 'number' as const },
    { name: 'OrderRegion', type: 'string' as const },
  ],
};

const DATASET_B = {
  id: 'ds_products',
  name: 'Products Table',
  description: 'Products dataset',
  rowCount: 450,
  columnCount: 3,
  lastUpdated: new Date().toISOString(),
  format: 'csv' as const,
  source: 'upload',
  status: 'Ready' as const,
  currentVersion: 1,
  isActive: false,
  columns: [
    { name: 'ProductId', type: 'identifier' as const },
    { name: 'ProductPrice', type: 'number' as const },
    { name: 'ProductCategory', type: 'string' as const },
  ],
};

const MODEL_A = {
  revision: 1,
  status: 'approved',
  fields: [
    { name: 'OrderRevenue', semantic_name: 'Order Revenue', role: 'measure', aggregations: ['SUM', 'AVG'], default_aggregation: 'SUM', type: 'decimal' },
    { name: 'OrderRegion', semantic_name: 'Order Region', role: 'dimension', aggregations: [], type: 'string' },
    { name: 'OrderId', semantic_name: 'Order ID', role: 'identifier', aggregations: [], type: 'string' },
  ],
  relationships: [],
  derived_metrics: [],
};

const MODEL_B = {
  revision: 1,
  status: 'approved',
  fields: [
    { name: 'ProductPrice', semantic_name: 'Product Price', role: 'measure', aggregations: ['AVG', 'MAX'], default_aggregation: 'AVG', type: 'decimal' },
    { name: 'ProductCategory', semantic_name: 'Product Category', role: 'dimension', aggregations: [], type: 'string' },
    { name: 'ProductId', semantic_name: 'Product ID', role: 'identifier', aggregations: [], type: 'string' },
  ],
  relationships: [],
  derived_metrics: [],
};

describe('Multi-Table / Dataset Scoping in GraphStudio and RAGChat', () => {
  it('directly shows column dropdowns without table selector when only one dataset exists', async () => {
    selectContext({ datasetId: 'ds_orders', version: 1, semanticRevision: 1 });

    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/datasets') {
        return Promise.resolve({ data: [DATASET_A] });
      }
      if (url.includes('semantics')) {
        return Promise.resolve({ data: [MODEL_A] });
      }
      if (url.includes('/recommendations')) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes('/insights/dashboard')) {
        return Promise.resolve({ data: { title: '', items: [] } });
      }
      return Promise.resolve({ data: [] });
    });

    render(<GraphStudio onNavigate={vi.fn()} user={{ role: 'Admin' }} />);

    // Wait for load
    await waitFor(() => {
      expect(screen.getByText('Target Measure (Y)')).toBeTruthy();
      expect(screen.getByText('Group by Dimension (X)')).toBeTruthy();
    });

    // When only 1 dataset exists, "Select Table / Dataset" MUST NOT be rendered
    expect(screen.queryByText('Select Table / Dataset')).toBeNull();

    // Verify columns from Table A are present
    expect(screen.getAllByText(/Order Revenue/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Order Region/).length).toBeGreaterThan(0);
  });

  it('shows table selector dropdown when more than one dataset exists and switches column dropdowns for both X and Y', async () => {
    selectContext({ datasetId: 'ds_orders', version: 1, semanticRevision: 1 });

    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/datasets') {
        return Promise.resolve({ data: [DATASET_A, DATASET_B] });
      }
      if (url.includes('ds_orders') && url.includes('semantics')) {
        return Promise.resolve({ data: [MODEL_A] });
      }
      if (url.includes('ds_products') && url.includes('semantics')) {
        return Promise.resolve({ data: [MODEL_B] });
      }
      if (url.includes('/recommendations')) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes('/insights/dashboard')) {
        return Promise.resolve({ data: { title: '', items: [] } });
      }
      return Promise.resolve({ data: [] });
    });

    render(<GraphStudio onNavigate={vi.fn()} user={{ role: 'Admin' }} />);

    // When multiple datasets exist, table selector MUST be rendered
    await waitFor(() => {
      expect(screen.getByText('Select Table / Dataset')).toBeTruthy();
      expect(screen.getByText('Target Measure (Y)')).toBeTruthy();
      expect(screen.getByText('Group by Dimension (X)')).toBeTruthy();
    });

    // Initially Table A (ds_orders) fields are shown
    expect(screen.getAllByText(/Order Revenue/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Order Region/).length).toBeGreaterThan(0);

    // Find table selector dropdown and select Table B (ds_products)
    const tableSelects = screen.getAllByRole('combobox');
    const tableSelect = tableSelects[0];
    fireEvent.change(tableSelect, { target: { value: 'ds_products' } });

    // Verify context updated and column dropdowns switched to Table B's columns
    await waitFor(() => {
      expect(screen.getAllByText(/Product Price/).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Product Category/).length).toBeGreaterThan(0);
    });

    // Verify execution context now reflects Table B
    expect(selectedContext()?.datasetId).toBe('ds_products');
  });

  it('does not render dataset scope dropdown in RAG Chat and queries embeddings directly without table selection', async () => {
    selectContext({ datasetId: 'ds_orders', version: 1, semanticRevision: 1 });

    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/datasets') {
        return Promise.resolve({ data: [DATASET_A, DATASET_B] });
      }
      if (url.includes('/chat/sessions')) {
        return Promise.resolve({ data: [] });
      }
      if (url.includes('/datasets/ds_orders/semantics')) {
        return Promise.resolve({ data: [MODEL_A] });
      }
      if (url.includes('/datasets/ds_products/semantics')) {
        return Promise.resolve({ data: [MODEL_B] });
      }
      return Promise.resolve({ data: [] });
    });

    render(<RAGChat isActive onNavigate={vi.fn()} />);

    // Verify Dataset Scope bar is NOT rendered in RAG Chat
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask anything about your data/i)).toBeTruthy();
    });

    expect(screen.queryByText('Dataset Scope:')).toBeNull();
    expect(screen.queryByText(/All Datasets \(Cross-Table Search\)/)).toBeNull();
  });
});
