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

const MOCK_DATASET = {
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

const MOCK_MODEL = {
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

describe('Build Your Dashboards (Combined Visual KPI Builder & Select Drag and Drop)', () => {
  it('combines Visual KPI Builder and Drag-and-Drop into "Build Your Dashboards" tab with dropdown switcher', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/datasets') return Promise.resolve({ data: [MOCK_DATASET] });
      if (url.includes('semantics')) return Promise.resolve({ data: [MOCK_MODEL] });
      if (url.includes('/recommendations')) return Promise.resolve({ data: [] });
      if (url.includes('/insights/dashboard')) return Promise.resolve({ data: { title: '', items: [] } });
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
      return Promise.resolve({ data: {} });
    });

    render(<GraphStudio onNavigate={vi.fn()} user={{ role: 'Admin' }} initialMode="visual" />);

    // 1. Verify "Build Your Dashboards" tab exists
    const dashboardTab = await screen.findByRole('button', { name: /Build Your Dashboards/i });
    expect(dashboardTab).toBeTruthy();

    // 2. Verify sub-mode dropdown is present
    expect(screen.getByText('Dashboard Creation Experience')).toBeTruthy();
    expect(screen.getByText('Build Manually')).toBeTruthy();

    // 3. In default "Build Manually" mode, the Visual KPI Builder is rendered
    expect(screen.getByText('Build a Business KPI or Chart')).toBeTruthy();
    expect(screen.getByPlaceholderText(/e.g. Net Revenue by Region/i)).toBeTruthy();

    // 4. Switch to "Select Drag and Drop" via the dropdown
    const modeDropdownBtn = screen.getByRole('button', { name: /Build Manually/i });
    fireEvent.click(modeDropdownBtn);

    const dragDropOption = await screen.findByRole('button', { name: /Select Drag and Drop/i });
    fireEvent.click(dragDropOption);

    // 5. Verify Drag and Drop Studio is rendered
    expect(await screen.findByText('Data Fields Palette')).toBeTruthy();
    expect(screen.getByText('Chart Types Library')).toBeTruthy();
    expect(screen.getByDisplayValue('My Custom Interactive Dashboard')).toBeTruthy();

    // Verify palettes show measures and dimensions
    expect(screen.getAllByText(/Revenue \(USD\)/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Business Department/i).length).toBeGreaterThan(0);

    // Verify chart types palette
    expect(screen.getAllByText('Bar Chart').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Line Trend').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Donut Chart').length).toBeGreaterThan(0);

    // 6. Test adding a new widget to the workspace
    const addWidgetBtn = screen.getByRole('button', { name: /Add Widget/i });
    fireEvent.click(addWidgetBtn);

    // Verify widget card added to canvas with live execution
    await waitFor(() => {
      expect(screen.getAllByText(/Target Measure/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Group Dimension/i).length).toBeGreaterThan(0);
    });

    // 7. Can switch back to "Build Manually" seamlessly
    const currentModeBtn = screen.getByRole('button', { name: /Select Drag and Drop/i });
    fireEvent.click(currentModeBtn);
    const buildManuallyOption = await screen.findByRole('button', { name: /Build Manually/i });
    fireEvent.click(buildManuallyOption);

    // Verify Visual KPI Builder is active again
    expect(await screen.findByText('Build a Business KPI or Chart')).toBeTruthy();
  });
});
