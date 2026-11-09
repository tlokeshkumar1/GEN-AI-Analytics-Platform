import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import api from '../services/api';
import { Sidebar } from '../components/Sidebar';
import { ExecutiveDashboard } from '../screens/ExecutiveDashboard';
import { GraphStudio } from '../screens/GraphStudio';
import { AnalyticsWidget } from '../components/AnalyticsWidget';
import { generateCustomGraph } from '../services/graphService';
import { contextHeaders, selectContext, selectedContext } from '../services/executionContext';
import { getTimeGreeting, resolveUserName, getUserInitials } from '../screens/RAGChat';

vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: (error: Error, fallback: string) => error.message || fallback,
}));

beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); sessionStorage.clear(); });
afterEach(cleanup);

describe('Platform correctness and navigation', () => {
  it('shows Administration and System Management for Admin or Admin+User and has no top-level cloud configuration entries', () => {
    render(<Sidebar activePath="executive-dashboard" onNavigate={vi.fn()} isOpen onClose={vi.fn()} user={{ role: 'Admin', roles: ['Admin'] }} />);
    expect(screen.getByText('Administration')).toBeTruthy();
    expect(screen.getByText('System Management')).toBeTruthy();
    expect(screen.queryByText('System Settings')).toBeNull();
    expect(screen.queryByRole('button', { name: /AWS|Azure|GCP/ })).toBeNull();
  });

  it('hides Administration section when user is only a user', () => {
    render(<Sidebar activePath="executive-dashboard" onNavigate={vi.fn()} isOpen onClose={vi.fn()} user={{ role: 'User', roles: ['User'] }} />);
    expect(screen.queryByText('Administration')).toBeNull();
    expect(screen.queryByText('System Management')).toBeNull();
    expect(screen.queryByText('AI Agents')).toBeNull();
    expect(screen.queryByText('Users')).toBeNull();
  });

  it('shows Administration section for Admin+User', () => {
    render(<Sidebar activePath="executive-dashboard" onNavigate={vi.fn()} isOpen onClose={vi.fn()} user={{ role: 'Admin+User', roles: ['Admin', 'Member'] }} />);
    expect(screen.getByText('Administration')).toBeTruthy();
    expect(screen.getByText('System Management')).toBeTruthy();
  });

  it('restricts widget publishing in Graph Studio for only user', async () => {
    selectContext({ datasetId: 'sales', version: 1, semanticRevision: 1 });
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url.includes('/semantics')) {
        return Promise.resolve({ data: [{ revision: 1, status: 'approved', fields: [] }] });
      }
      if (url.includes('/recommendations')) {
        return Promise.resolve({
          data: [{
            id: 'kpi_1',
            revision: 1,
            title: 'Monthly Net Revenue',
            status: 'approved',
            kind: 'kpi',
            query_plan: { metric: 'NetRevenue', aggregation: 'SUM' },
          }],
        });
      }
      return Promise.resolve({ data: [] });
    }) as any);

    render(<GraphStudio onNavigate={vi.fn()} user={{ role: 'User', roles: ['User'] }} />);
    expect(await screen.findByText('Monthly Net Revenue')).toBeTruthy();
    expect(screen.getByText('Publishing (Admin Only)')).toBeTruthy();
    expect(screen.queryByText('Include on Dashboard')).toBeNull();
    expect(screen.getByText('Publishing Restricted to Administrators')).toBeTruthy();
  });

  it('allows widget publishing in Graph Studio for Admin or Admin+User', async () => {
    selectContext({ datasetId: 'sales', version: 1, semanticRevision: 1 });
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url.includes('/semantics')) {
        return Promise.resolve({ data: [{ revision: 1, status: 'approved', fields: [] }] });
      }
      if (url.includes('/recommendations')) {
        return Promise.resolve({
          data: [{
            id: 'kpi_1',
            revision: 1,
            title: 'Monthly Net Revenue',
            status: 'approved',
            kind: 'kpi',
            query_plan: { metric: 'NetRevenue', aggregation: 'SUM' },
          }],
        });
      }
      return Promise.resolve({ data: [] });
    }) as any);

    render(<GraphStudio onNavigate={vi.fn()} user={{ role: 'Admin+User', roles: ['Admin', 'Member'] }} />);
    expect(await screen.findByText('Monthly Net Revenue')).toBeTruthy();
    expect(screen.getByText('Include on Dashboard')).toBeTruthy();
    expect(screen.queryByText('Publishing (Admin Only)')).toBeNull();
    expect(screen.getByText('No widgets selected for Executive Dashboard')).toBeTruthy();
  });

  it('renders scatter chart without error even when only one numeric measure is present', () => {
    const definition = {
      id: 'net_rev_scatter',
      title: 'Monthly Net Revenue',
      kind: 'scatter',
      revision: 1,
      semantic_revision: 1,
      query_plan: { metric: 'NetRevenue', dimension: 'MonthName' },
      dependencies: ['NetRevenue', 'MonthName'],
      explanation: 'Monthly Net Revenue scatter test',
      status: 'approved' as const,
    };
    const result = {
      success: true,
      data: [
        { MonthName: 'Jan', NetRevenue: 150000 },
        { MonthName: 'Feb', NetRevenue: 180000 },
        { MonthName: 'Mar', NetRevenue: 210000 },
      ],
      summary: { formatted_value: '$540.00K' },
      records_matched: 3,
      execution_backend: 'pandas',
      execution_time_ms: 1.2,
    };

    render(<AnalyticsWidget definition={definition} result={result} />);
    expect(screen.queryByText('Scatter charts require two numeric measures.')).toBeNull();
    expect(screen.getByRole('img', { name: 'Monthly Net Revenue' })).toBeTruthy();
  });

  it('isolates dataset selection by account and carries pinned versions', () => {
    localStorage.setItem('auth_user', JSON.stringify({ user_id: 'alice' }));
    selectContext({ datasetId: 'hr', version: 2, semanticRevision: 4 });
    localStorage.setItem('auth_user', JSON.stringify({ user_id: 'bob' }));
    expect(selectedContext()).toBeNull();
    expect(contextHeaders()).toEqual({});
    selectContext({ datasetId: 'factory', version: 1, semanticRevision: 1 });
    localStorage.setItem('auth_user', JSON.stringify({ user_id: 'alice' }));
    expect(contextHeaders()).toEqual({ 'X-Dataset-Id': 'hr', 'X-Dataset-Version': '2', 'X-Semantic-Revision': '4' });
  });

  it('never replaces failed graphs or missing images with a successful sample', async () => {
    vi.mocked(api.post).mockRejectedValueOnce(new Error('Provider unavailable'));
    await expect(generateCustomGraph('Plot output')).rejects.toThrow('Provider unavailable');
    vi.mocked(api.post).mockResolvedValueOnce({ data: { status: 'success', image_base64: '' } });
    await expect(generateCustomGraph('Plot output')).rejects.toThrow('did not return');
  });

  it('renders only widgets actually returned by the published dashboard', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { title: 'HR dashboard', status: 'published', widgets: [{
      definition: { id: 'headcount', revision: 1, title: 'Employee records', kind: 'kpi', query_plan: { metric: '*', aggregation: 'COUNT' }, explanation: 'Reviewed source grain.' },
      result: { success: true, data: [{ value: 2 }], summary: { formatted_value: '2' }, records_matched: 2, execution_backend: 'pandas', execution_time_ms: 1.25 },
    }] } });
    render(<ExecutiveDashboard onNavigate={vi.fn()} />);
    expect(await screen.findByText('Employee records')).toBeTruthy();
    expect(screen.queryByText('Total Net Revenue')).toBeNull();
    expect(screen.getByText('2')).toBeTruthy();
  });

  it('correctly resolves time greeting and usernames without exposing emails', () => {
    // Test greetings across time
    expect(getTimeGreeting(new Date('2026-10-30T08:30:00'))).toBe('Good morning');
    expect(getTimeGreeting(new Date('2026-10-30T14:30:00'))).toBe('Good afternoon');
    expect(getTimeGreeting(new Date('2026-10-30T19:30:00'))).toBe('Good evening');
    expect(getTimeGreeting(new Date('2026-10-30T23:30:00'))).toBe('Good evening');

    // Test username resolution (never showing email)
    expect(resolveUserName({ name: 'Lokesh Kumar T', email: 'lokesh@neovatic.com' })).toBe('Lokesh Kumar T');
    expect(resolveUserName({ name: 'lokesh.kumar@neovatic.com', email: 'lokesh.kumar@neovatic.com' })).toBe('Lokesh Kumar');
    expect(resolveUserName({ name: 'admin@sap.corp', email: 'admin@sap.corp' })).toBe('Admin');
    expect(resolveUserName({ user_id: 'alice' })).toBe('Alice');
    expect(resolveUserName(null)).toBe('User');

    // Test initials
    expect(getUserInitials('Lokesh Kumar T')).toBe('LT');
    expect(getUserInitials('Lokesh Kumar')).toBe('LK');
    expect(getUserInitials('Admin')).toBe('AD');
  });
});
