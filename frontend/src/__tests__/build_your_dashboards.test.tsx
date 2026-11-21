import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import api from '../services/api';
import { GraphStudio } from '../screens/GraphStudio';

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

const MOCK_DATASET_1 = {
  id: 'ds_finance',
  name: 'Financial Ledger',
  tableName: 'Financial_Ledger',
  rowCount: 1250,
  columnCount: 3,
  lastUpdated: new Date().toISOString(),
  format: 'csv' as const,
  source: 'upload',
  status: 'Ready' as const,
  currentVersion: 1,
  isActive: true,
  columns: [
    { name: 'Revenue', type: 'decimal' as const, role: 'measure' },
    { name: 'Cost', type: 'decimal' as const, role: 'measure' },
    { name: 'Department', type: 'string' as const, role: 'dimension' },
  ],
};

const MOCK_DATASET_2 = {
  id: 'ds_projects',
  name: 'Project Portfolio',
  tableName: 'Project_Portfolio',
  rowCount: 450,
  columnCount: 3,
  lastUpdated: new Date().toISOString(),
  format: 'csv' as const,
  source: 'upload',
  status: 'Ready' as const,
  currentVersion: 1,
  isActive: false,
  columns: [
    { name: 'Delayed_days', type: 'decimal' as const, role: 'measure' },
    { name: 'Project_ID', type: 'string' as const, role: 'dimension' },
  ],
};

const MOCK_MODEL_1 = {
  revision: 1,
  status: 'approved',
  fields: [
    { name: 'Revenue', semantic_name: 'Revenue (USD)', role: 'measure', type: 'decimal' },
    { name: 'Cost', semantic_name: 'Operating Cost', role: 'measure', type: 'decimal' },
    { name: 'Department', semantic_name: 'Business Department', role: 'dimension', type: 'string' },
  ],
  relationships: [],
  derived_metrics: [],
};

const MOCK_MODEL_2 = {
  revision: 1,
  status: 'approved',
  fields: [
    { name: 'Delayed_days', semantic_name: 'Delayed Days', role: 'measure', type: 'decimal' },
    { name: 'Project_ID', semantic_name: 'Project ID', role: 'dimension', type: 'string' },
  ],
  relationships: [],
  derived_metrics: [],
};

describe('Build Your Dashboards (Combined Visual KPI Builder & Select Drag and Drop)', () => {
  it('combines Visual KPI Builder and Drag-and-Drop with step-by-step creation and preserves tab on dataset switch', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/datasets') return Promise.resolve({ data: [MOCK_DATASET_1, MOCK_DATASET_2] });
      if (url.includes('ds_finance') && url.includes('semantics')) return Promise.resolve({ data: [MOCK_MODEL_1] });
      if (url.includes('ds_projects') && url.includes('semantics')) return Promise.resolve({ data: [MOCK_MODEL_2] });
      if (url.includes('semantics')) return Promise.resolve({ data: [MOCK_MODEL_1] });
      if (url.includes('/recommendations')) return Promise.resolve({ data: [] });
      if (url.includes('/insights/dashboard')) return Promise.resolve({ data: { title: 'Executive Analytics Dashboard', items: [{ id: 'existing_kpi_1', revision: 1 }] } });
      return Promise.resolve({ data: [] });
    });

    vi.mocked(api.post).mockImplementation((url: string) => {
      if (url === '/insights/execute') {
        return Promise.resolve({
          data: {
            success: true,
            data: [
              { Department: 'Engineering', Revenue: 500000, value: 500000 },
              { Department: 'Marketing', Revenue: 300000, value: 300000 },
            ],
            columns: ['Department', 'Revenue'],
            execution_time_ms: 12,
          },
        });
      }
      if (url === '/insights/dashboard') {
        return Promise.resolve({ data: { status: 'published' } });
      }
      return Promise.resolve({ data: {} });
    });

    render(<GraphStudio onNavigate={vi.fn()} user={{ role: 'Admin' }} initialMode="visual" />);

    // 1. Verify "Build Your Dashboards" tab exists
    const dashboardTab = await screen.findByRole('button', { name: /Build Your Dashboards/i });
    expect(dashboardTab).toBeTruthy();

    // 2. Verify sub-mode dropdown is present
    expect(screen.getByText('Dashboard Creation Experience')).toBeTruthy();
    expect(screen.getByText('Build Manually')).toBeTruthy();

    // 3. In default "Build Manually" mode, Visual KPI Builder is rendered
    expect(screen.getByText('Build a Business KPI or Chart')).toBeTruthy();
    expect(screen.getByPlaceholderText(/e.g. Net Revenue by Region/i)).toBeTruthy();

    // 4. Switch to "Select Drag and Drop" via the dropdown
    const modeDropdownBtn = screen.getByRole('button', { name: /Build Manually/i });
    fireEvent.click(modeDropdownBtn);

    const dragDropOption = await screen.findByRole('button', { name: /Select Drag and Drop/i });
    fireEvent.click(dragDropOption);

    // 5. Verify 3-column layout rendered:
    // Left: Chart Types Library
    expect((await screen.findAllByText('Chart Types Library')).length).toBeGreaterThan(0);
    // Middle: Your Dashboard Canvas in initial Empty State
    expect(screen.getByText('Your Dashboard Canvas')).toBeTruthy();
    expect(screen.getByText('Your Dashboard Canvas is Empty')).toBeTruthy();
    // Right: Data Fields Palette
    expect(screen.getByText('Data Fields Palette')).toBeTruthy();

    // Verify palettes show measures and dimensions
    expect(screen.getAllByText(/Revenue \(USD\)/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Business Department/i).length).toBeGreaterThan(0);

    // Verify chart types palette
    expect(screen.getAllByText('Bar Chart').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Line Trend').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Donut Chart').length).toBeGreaterThan(0);

    // 6. Step 1: Select Chart Type (Bar Chart)
    const barChartItem = screen.getAllByText('Bar Chart')[0];
    fireEvent.click(barChartItem);

    // Canvas transitions to Configuration Card with empty dropzones
    expect(await screen.findByText('Bar Chart Configuration')).toBeTruthy();
    expect(screen.getAllByText(/X-Axis \/ Category Dimension/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Y-Axis \/ Metric Measure/i).length).toBeGreaterThan(0);

    // Verify Create Widget is disabled because 2 fields are required
    const createBtn = screen.getByRole('button', { name: /Create Widget/i });
    expect(createBtn).toHaveProperty('disabled', true);

    // 7. Step 2: Assign required data fields from Data Fields Palette
    // Click '+' on Business Department
    const plusButtons = screen.getAllByTitle('Place into canvas');
    expect(plusButtons.length).toBeGreaterThan(0);
    // Assign field 1
    fireEvent.click(plusButtons[0]);
    // Assign field 2
    fireEvent.click(plusButtons[1]);

    // Validation confirms complete and Create Widget button becomes enabled
    await waitFor(() => {
      expect(screen.getByText(/Configuration complete/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Create Widget/i })).toHaveProperty('disabled', false);
    });

    // 8. Step 4: Click Create Widget to generate widget
    fireEvent.click(screen.getByRole('button', { name: /Create Widget/i }));

    // Verify widget preview rendered
    await waitFor(() => {
      expect(screen.getByText(/Widget Generated Successfully/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /Publish to Executive Dashboard/i })).toBeTruthy();
    });

    // 9. Step 5: Publish widget appends to Executive Dashboard (preserves existing widgets)
    const publishBtn = screen.getByRole('button', { name: /Publish to Executive Dashboard/i });
    fireEvent.click(publishBtn);

    await waitFor(() => {
      expect(screen.getByText(/Successfully published/i)).toBeTruthy();
      expect(screen.getByText(/Added alongside 1 existing published widget/i)).toBeTruthy();
    });

    // 10. Switch Active Dataset Source: verify user stays in "Select Drag and Drop" tab
    const datasetSelect = screen.getByRole('combobox', { name: /Active Dataset Source/i });
    fireEvent.change(datasetSelect, { target: { value: 'ds_projects' } });

    // The user must remain in Build Your Dashboards tab and Select Drag and Drop mode
    await waitFor(() => {
      expect(screen.getByText('Select Drag and Drop Dashboard Builder')).toBeTruthy();
      expect(screen.getAllByText('Chart Types Library').length).toBeGreaterThan(0);
    });

    // 11. Can switch back to "Build Manually" seamlessly
    const currentModeBtn = screen.getByRole('button', { name: /Select Drag and Drop/i });
    fireEvent.click(currentModeBtn);
    const buildManuallyOption = await screen.findByRole('button', { name: /Build Manually/i });
    fireEvent.click(buildManuallyOption);

    // Verify Visual KPI Builder is active again
    expect(await screen.findByText('Build a Business KPI or Chart')).toBeTruthy();
  });
});
