import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(cleanup);

describe('Professional Sidebar Redesign (Astryx Design System)', () => {
  it('renders in expanded mode with labels, headings, and collapse toggle button', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    const onToggleCollapse = vi.fn();

    render(
      <Sidebar
        activePath="executive-dashboard"
        onNavigate={onNavigate}
        isOpen={true}
        onClose={onClose}
        isCollapsed={false}
        onToggleCollapse={onToggleCollapse}
        user={{ name: 'Alex Rivera', email: 'alex@neovatic.ai', role: 'Admin', roles: ['Admin'] }}
      />
    );

    // Platform Navigation & Group headings
    expect(screen.getByText('Platform Navigation')).toBeTruthy();
    expect(screen.getByText('AI Dashboards')).toBeTruthy();
    expect(screen.getByText('Administration')).toBeTruthy();
    expect(screen.getByText('Other Services')).toBeTruthy();

    // Navigation Labels
    expect(screen.getByText('Executive Dashboard')).toBeTruthy();
    expect(screen.getByText('Build Your KPI')).toBeTruthy();
    expect(screen.getByText('Data Explorer')).toBeTruthy();

    // User profile in expanded mode
    expect(screen.getByText('Alex Rivera')).toBeTruthy();
    expect(screen.getByText('alex@neovatic.ai')).toBeTruthy();
    expect(screen.getByText('Log Out')).toBeTruthy();

    // Collapse toggle button is accessible
    const collapseBtn = screen.getByLabelText(/Collapse sidebar/i);
    expect(collapseBtn).toBeTruthy();
    fireEvent.click(collapseBtn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it('renders in collapsed mode (compact rail) with icon tooltips and expand toggle', () => {
    const onNavigate = vi.fn();
    const onToggleCollapse = vi.fn();

    render(
      <Sidebar
        activePath="executive-dashboard"
        onNavigate={onNavigate}
        isOpen={false}
        onClose={vi.fn()}
        isCollapsed={true}
        onToggleCollapse={onToggleCollapse}
        user={{ name: 'Alex Rivera', email: 'alex@neovatic.ai', role: 'Admin', roles: ['Admin'] }}
      />
    );

    // In collapsed mode, sidebar container has compact width class w-[72px]
    const sidebar = screen.getByTestId('application-sidebar');
    expect(sidebar.className).toContain('w-[72px]');

    // Expand toggle button is present
    const expandBtn = screen.getByLabelText(/Expand sidebar/i);
    expect(expandBtn).toBeTruthy();
    fireEvent.click(expandBtn);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    // Tooltips are provided for items in collapsed mode
    const tooltips = screen.getAllByRole('tooltip');
    expect(tooltips.length).toBeGreaterThan(0);
    expect(screen.getAllByText('Executive Dashboard').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Build Your KPI').length).toBeGreaterThan(0);
  });

  it('remembers collapsed state in localStorage when toggled using internal state', () => {
    const { unmount } = render(
      <Sidebar
        activePath="executive-dashboard"
        onNavigate={vi.fn()}
        isOpen={false}
        onClose={vi.fn()}
        user={{ role: 'Admin', roles: ['Admin'] }}
      />
    );

    // Initial state is expanded
    expect(localStorage.getItem('sidebar_collapsed')).toBeNull();

    // Click collapse button
    const collapseBtn = screen.getByLabelText(/Collapse sidebar/i);
    fireEvent.click(collapseBtn);
    expect(localStorage.getItem('sidebar_collapsed')).toBe('true');

    unmount();

    // Mount again, should read collapsed from localStorage
    render(
      <Sidebar
        activePath="executive-dashboard"
        onNavigate={vi.fn()}
        isOpen={false}
        onClose={vi.fn()}
        user={{ role: 'Admin', roles: ['Admin'] }}
      />
    );

    const sidebar = screen.getByTestId('application-sidebar');
    expect(sidebar.className).toContain('w-[72px]');
  });

  it('supports expandable and collapsible accordion submenu sections', () => {
    render(
      <Sidebar
        activePath="data-sources"
        onNavigate={vi.fn()}
        isOpen={true}
        onClose={vi.fn()}
        isCollapsed={false}
        user={{ role: 'Admin', roles: ['Admin'] }}
      />
    );

    // AI Dashboards button toggles open/close
    const aiDashboardsBtn = screen.getByRole('button', { name: /AI Dashboards/i });
    expect(screen.getByText('Build Your KPI')).toBeTruthy();

    // Click to collapse
    fireEvent.click(aiDashboardsBtn);
    expect(screen.queryByText('Build Your KPI')).toBeNull();

    // Click to re-expand
    fireEvent.click(aiDashboardsBtn);
    expect(screen.getByText('Build Your KPI')).toBeTruthy();
  });

  it('closes mobile drawer and triggers navigation when item or backdrop is clicked', () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();

    render(
      <Sidebar
        activePath="executive-dashboard"
        onNavigate={onNavigate}
        isOpen={true}
        onClose={onClose}
        isCollapsed={false}
        user={{ role: 'User', roles: ['User'] }}
      />
    );

    // Click backdrop overlay
    const backdrop = screen.getByTestId('sidebar-backdrop');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Click a navigation item
    const navItem = screen.getByText('Data Explorer');
    fireEvent.click(navItem);
    expect(onNavigate).toHaveBeenCalledWith('data-explorer');
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
