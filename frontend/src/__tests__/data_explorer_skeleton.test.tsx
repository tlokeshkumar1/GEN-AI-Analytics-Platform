import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DataExplorer } from '../screens/DataExplorer';
import { DataExplorerSkeleton } from '../components/dashboard/DataExplorerSkeleton';
import * as semanticService from '../services/semanticService';
import * as executionContext from '../services/executionContext';

vi.mock('../services/executionContext', () => ({
  selectedContext: vi.fn(),
  ensureDefaultContext: vi.fn(),
}));

vi.mock('../services/semanticService', () => ({
  getSemanticModels: vi.fn(),
  executePlan: vi.fn(),
}));

vi.mock('../services/analyticsService', () => ({
  queryAnalytics: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(cleanup);

const MOCK_MODEL = {
  revision: 1,
  status: 'approved',
  fields: [
    { name: 'Revenue', semantic_name: 'Revenue (USD)', role: 'measure', type: 'decimal', aggregations: ['SUM', 'AVG'] },
    { name: 'Cost', semantic_name: 'Cost (USD)', role: 'measure', type: 'decimal', aggregations: ['SUM', 'AVG'] },
    { name: 'Department', semantic_name: 'Department', role: 'dimension', type: 'string' },
  ],
  relationships: [],
  derived_metrics: [],
};

describe('DataExplorer Skeleton Loader', () => {
  it('renders standalone DataExplorerSkeleton with top and bottom cards matching the layout', () => {
    const { rerender } = render(<DataExplorerSkeleton mode="structured" />);

    expect(screen.getByTestId('data-explorer-skeleton')).toBeTruthy();
    expect(screen.getByTestId('data-explorer-top-skeleton')).toBeTruthy();
    expect(screen.getByTestId('data-explorer-bottom-skeleton')).toBeTruthy();

    // In structured mode, top card has 3-column input placeholders
    rerender(<DataExplorerSkeleton mode="natural" />);
    expect(screen.getByTestId('data-explorer-top-skeleton')).toBeTruthy();
  });

  it('keeps skeleton visible while loading and does NOT show empty spaces or placeholder text', async () => {
    vi.mocked(executionContext.selectedContext).mockReturnValue({
      datasetId: 'ds_1',
      version: 1,
      semanticRevision: 1,
    });

    let resolveModels: (val: any) => void = () => {};
    const pendingPromise = new Promise(resolve => {
      resolveModels = resolve;
    });
    vi.mocked(semanticService.getSemanticModels).mockReturnValue(pendingPromise as any);

    render(<DataExplorer onNavigate={vi.fn()} />);

    // 1. While data is loading, skeleton MUST be displayed
    expect(screen.getByTestId('data-explorer-skeleton')).toBeTruthy();
    expect(screen.getByTestId('data-explorer-top-skeleton')).toBeTruthy();
    expect(screen.getByTestId('data-explorer-bottom-skeleton')).toBeTruthy();

    // 2. Placeholder text or empty-state text MUST NOT be displayed while loading
    expect(screen.queryByText(/No semantic model available/i)).toBeNull();
    expect(screen.queryByText(/Select dimensions or enter a natural language prompt/i)).toBeNull();

    // 3. Resolve data
    resolveModels([MOCK_MODEL]);

    // 4. Once data is fully loaded, content smoothly replaces the skeleton
    await waitFor(() => {
      expect(screen.queryByTestId('data-explorer-skeleton')).toBeNull();
      expect(screen.getByText(/Query Engine/i)).toBeTruthy();
      expect(screen.getByText(/Structured Query/i)).toBeTruthy();
      expect(screen.getByText(/Execute query/i)).toBeTruthy();
    });
  });

  it('displays bottom results skeleton when query is executing instead of empty spaces', async () => {
    vi.mocked(executionContext.selectedContext).mockReturnValue({
      datasetId: 'ds_1',
      version: 1,
      semanticRevision: 1,
    });
    vi.mocked(semanticService.getSemanticModels).mockResolvedValue([MOCK_MODEL as any]);

    let resolvePlan: (val: any) => void = () => {};
    const pendingPlan = new Promise(resolve => {
      resolvePlan = resolve;
    });
    vi.mocked(semanticService.executePlan).mockReturnValue(pendingPlan as any);

    render(<DataExplorer onNavigate={vi.fn()} />);

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByText(/Execute query/i)).toBeTruthy();
    });

    // Execute query
    const executeBtn = screen.getByText(/Execute query/i);
    fireEvent.click(executeBtn);

    // While busy executing query, bottom results skeleton MUST be visible (not blank/empty space)
    expect(screen.getByTestId('data-explorer-bottom-skeleton')).toBeTruthy();
    expect(screen.queryByText(/Analytical Output Canvas/i)).toBeNull();

    // Resolve plan
    resolvePlan({
      success: true,
      status: 'success',
      data: [{ Department: 'Sales', Revenue: 5000 }],
      summary: {},
      records_matched: 1,
      records_total: 1,
      execution_time_ms: 15.2,
      context: {},
      execution_backend: 'duckdb',
    });

    // Verify results replace the skeleton
    await waitFor(() => {
      expect(screen.queryByTestId('data-explorer-bottom-skeleton')).toBeNull();
      expect(screen.getByText(/Query results/i)).toBeTruthy();
    });
  });
});
