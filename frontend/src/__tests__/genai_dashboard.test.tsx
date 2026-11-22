import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import api from '../services/api';
import { GraphStudio } from '../screens/GraphStudio';

vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: (error: Error, fallback: string) => error.message || fallback,
  streamingRequestHeaders: () => ({}),
}));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(cleanup);

const MOCK_DATASET = {
  id: 'ds_sales',
  name: 'Sales Revenue Table',
  description: 'Enterprise sales data',
  rowCount: 5400,
  columnCount: 4,
  lastUpdated: new Date().toISOString(),
  format: 'csv' as const,
  source: 'upload',
  status: 'Ready' as const,
  currentVersion: 1,
  isActive: true,
  columns: [
    { name: 'Revenue', type: 'decimal' as const, role: 'measure' },
    { name: 'Region', type: 'string' as const, role: 'dimension' },
    { name: 'Category', type: 'string' as const, role: 'dimension' },
    { name: 'OrderId', type: 'identifier' as const, role: 'identifier' },
  ],
};

const MOCK_GENAI_RESPONSE = {
  status: 'success',
  dashboard_id: 'genai_dash_12345',
  prompt: 'Show revenue and average order by region with category breakdown',
  intent_summary: 'Comprehensive sales performance analysis across geographic regions and product lines.',
  execution_time_ms: 340,
  workflow_steps: [
    { step: 'Step 1', name: 'Understand', detail: 'Understood natural language intent', timestamp: 20, status: 'completed' },
    { step: 'Step 2', name: 'Explore', detail: 'Inspected table schema', timestamp: 45, status: 'completed' },
    { step: 'Step 3', name: 'Identify', detail: 'Identified Revenue and Region', timestamp: 60, status: 'completed' },
    { step: 'Step 4', name: 'Relate', detail: 'Single-table execution verified', timestamp: 75, status: 'completed' },
    { step: 'Step 5', name: 'Generate & Execute', detail: 'Generated dynamic SQL', timestamp: 120, status: 'completed' },
    { step: 'Step 6', name: 'Validate', detail: 'Validated 5,400 records matched', timestamp: 150, status: 'completed' },
    { step: 'Step 7', name: 'Analyze', detail: 'Computed regional distributions', timestamp: 200, status: 'completed' },
    { step: 'Step 8', name: 'Recommend', detail: 'Proactively generated recommendations', timestamp: 240, status: 'completed' },
    { step: 'Step 9', name: 'Render', detail: 'Structured KPI cards and charts', timestamp: 280, status: 'completed' },
    { step: 'Step 10', name: 'Visualize', detail: 'Generated visual representations', timestamp: 340, status: 'completed' },
  ],
  sql_info: {
    sql_query: 'SELECT Region, SUM(Revenue) AS Total_Revenue FROM Sales GROUP BY Region ORDER BY Total_Revenue DESC',
    join_required: false,
    records_matched: 5400,
    records_total: 5400,
  },
  kpi_cards: [
    {
      id: 'kpi_rev',
      title: 'Total Gross Revenue',
      value: 1245000,
      metric: 'Revenue',
      aggregation: 'SUM',
      format: 'currency',
      subtitle: 'Aggregated across all sales',
    },
    {
      id: 'kpi_orders',
      title: 'Total Orders Placed',
      value: 5400,
      metric: 'OrderId',
      aggregation: 'COUNT',
      format: 'integer',
      subtitle: 'Volume count',
    },
  ],
  charts: [
    {
      id: 'chart_reg',
      title: 'Revenue by Region',
      kind: 'bar',
      metric: 'Revenue',
      dimension: 'Region',
      aggregation: 'SUM',
      data: [
        { label: 'North America', value: 650000 },
        { label: 'EMEA', value: 390000 },
        { label: 'APAC', value: 205000 },
      ],
    },
  ],
  python_visual: {
    image_base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    chart_type: 'heatmap',
    prompt: 'Correlation heatmap across Revenue and Region',
    verified: true,
  },
  executive_insights: [
    'North America generated 52.2% of total sales revenue ($650,000), leading all regions.',
    'Total order volume remained strong at 5,400 validated transactions.',
  ],
  recommendations: [
    {
      id: 'rec_cat',
      title: 'Category Sales Composition',
      kind: 'donut',
      metric: 'Revenue',
      dimension: 'Category',
      aggregation: 'SUM',
      rationale: 'Surfaces product line concentration to balance regional exposure.',
      status: 'recommended',
    },
  ],
};

describe('Generative AI Dashboards (10-Step Analysis-First Workflow)', () => {
  it('renders "1. Generative AI Dashboards" tab and executes complete analysis-first pipeline', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/datasets') return Promise.resolve({ data: [MOCK_DATASET] });
      if (url.includes('semantics')) {
        return Promise.resolve({
          data: [{
            revision: 1,
            status: 'approved',
            fields: [
              { name: 'Revenue', semantic_name: 'Revenue', role: 'measure', type: 'decimal' },
              { name: 'Region', semantic_name: 'Region', role: 'dimension', type: 'string' },
            ],
            relationships: [],
            derived_metrics: [],
          }],
        });
      }
      if (url.includes('/recommendations')) return Promise.resolve({ data: [] });
      if (url.includes('/insights/dashboard')) return Promise.resolve({ data: { title: '', items: [] } });
      return Promise.resolve({ data: [] });
    });

    vi.mocked(api.post).mockImplementation((url: string) => {
      if (url === '/graph/genai-dashboard/generate') {
        return Promise.resolve({ data: MOCK_GENAI_RESPONSE });
      }
      if (url === '/graph/genai-dashboard/execute-widget') {
        return Promise.resolve({
          data: {
            kind: 'donut',
            widget: {
              id: 'rec_cat',
              title: 'Category Sales Composition',
              kind: 'donut',
              metric: 'Revenue',
              dimension: 'Category',
              aggregation: 'SUM',
              data: [
                { label: 'Software', value: 800000 },
                { label: 'Hardware', value: 445000 },
              ],
            },
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    const ssePayload = [
      `data: ${JSON.stringify({ type: 'step', step: 1, name: 'Understand', detail: 'Understanding prompt...', timestamp: 10 })}\n\n`,
      `data: ${JSON.stringify({ type: 'result', data: MOCK_GENAI_RESPONSE })}\n\n`,
    ].join('');

    const mockResponseStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ssePayload));
        controller.close();
      },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: mockResponseStream,
    }));

    render(<GraphStudio onNavigate={vi.fn()} user={{ role: 'Admin', roles: ['Admin'] }} initialMode="prompt" />);

    // Check header and mode tab
    expect((await screen.findAllByText('1. Generative AI Dashboards')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Universal Natural Language Understanding/i)).toBeTruthy();

    // Type query and run
    const textarea = screen.getByPlaceholderText(/Generate an executive dashboard/i);
    fireEvent.change(textarea, { target: { value: 'Show revenue and average order by region' } });

    const runBtn = screen.getByRole('button', { name: /Execute Analysis & Generate Dashboard/i });
    fireEvent.click(runBtn);

    // Verify 10-step stepper is rendered
    expect(await screen.findByText('Mandatory 10-Step Analysis-First Execution Pipeline')).toBeTruthy();

    // Wait for analysis results
    await waitFor(() => {
      expect(screen.getByText('Total Gross Revenue')).toBeTruthy();
    });

    // Verify KPI card value formatted as currency
    expect(screen.getByText('$1,245,000.00')).toBeTruthy();
    expect(screen.getByText('Total Orders Placed')).toBeTruthy();

    // Verify AI Executive Insights
    expect(screen.getByText(/North America generated 52.2% of total sales revenue/i)).toBeTruthy();

    // Verify Chart rendering
    expect(screen.getByText('Revenue by Region')).toBeTruthy();
    expect(screen.getByText('North America')).toBeTruthy();

    // Verify Approve, Reject, and Preview Live buttons on generated widgets
    const previewLiveBtns = screen.getAllByRole('button', { name: /Preview Live/i });
    expect(previewLiveBtns.length).toBeGreaterThanOrEqual(2);

    const approveBtns = screen.getAllByRole('button', { name: /Approve/i });
    expect(approveBtns.length).toBeGreaterThanOrEqual(2);

    const rejectBtns = screen.getAllByRole('button', { name: /Reject/i });
    expect(rejectBtns.length).toBeGreaterThanOrEqual(2);

    // Test Preview Live Modal
    fireEvent.click(previewLiveBtns[0]);
    expect(await screen.findByText('Live Preview & Verification Mode')).toBeTruthy();
    expect(screen.getByText('Close Preview')).toBeTruthy();
    fireEvent.click(screen.getByText('Close Preview'));
    expect(screen.queryByText('Live Preview & Verification Mode')).toBeNull();

    // Test Rejecting a widget
    fireEvent.click(rejectBtns[0]);
    expect(screen.getByText(/rejected/i)).toBeTruthy();

    // Verify Python visual card
    expect(screen.getByText('Python Matplotlib / Seaborn Advanced Visualization')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download High-Res PNG/i })).toBeTruthy();

    // Verify Proactive AI Recommendations section
    expect(screen.getByText('Proactive AI Widget Recommendations (Analysis-First)')).toBeTruthy();
    expect(screen.getByText('Category Sales Composition')).toBeTruthy();

    // Executed recommendations remain pending until preview and approval.
    const addRecBtn = screen.getByRole('button', { name: /Add to Dashboard/i });
    fireEvent.click(addRecBtn);

    await waitFor(() => {
      expect(screen.getByText(/Executed "Category Sales Composition". Preview and approve it before publishing./i)).toBeTruthy();
    });

    const previewButtons = screen.getAllByRole('button', { name: /Preview Live/i });
    fireEvent.click(previewButtons[0]);
    await waitFor(() => {
      expect(vi.mocked(api.post).mock.calls.some(([url]) => url === '/graph/genai-dashboard/execute-widget')).toBe(true);
      expect(screen.getByText('Live Preview & Verification Mode')).toBeTruthy();
    });
    expect(screen.getByText(/Status: pending/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Approve Widget/i }));

    // Verify SQL Inspector
    const inspectBtn = screen.getByRole('button', { name: /Inspect SQL & Join Plan/i });
    fireEvent.click(inspectBtn);
    expect(screen.getByText(/SELECT Region, SUM\(Revenue\) AS Total_Revenue/i)).toBeTruthy();
  });
});
