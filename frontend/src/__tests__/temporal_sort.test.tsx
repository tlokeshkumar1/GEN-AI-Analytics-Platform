import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { parseTemporalSortKey, isTemporalColumn, AnalyticsWidget } from '../components/AnalyticsWidget';
import { AnalyticsDefinition, ExecutionResult } from '../services/semanticService';

describe('Temporal sorting utilities', () => {
  it('correctly parses Year-Month formats into sortable numeric keys', () => {
    const k1 = parseTemporalSortKey('2023-01');
    const k2 = parseTemporalSortKey('2023-08');
    const k3 = parseTemporalSortKey('2024-01');
    const k4 = parseTemporalSortKey('2025-11');
    const k5 = parseTemporalSortKey('2025-12');

    expect(k1).toBe(202301);
    expect(k2).toBe(202308);
    expect(k3).toBe(202401);
    expect(k4).toBe(202511);
    expect(k5).toBe(202512);

    expect(k1! < k2!).toBe(true);
    expect(k2! < k3!).toBe(true);
    expect(k3! < k4!).toBe(true);
    expect(k4! < k5!).toBe(true);
  });

  it('correctly parses Year-only numbers and strings', () => {
    const y2023 = parseTemporalSortKey(2023);
    const y2024 = parseTemporalSortKey('2024');
    const y2025 = parseTemporalSortKey(2025);

    expect(y2023).toBe(202300);
    expect(y2024).toBe(202400);
    expect(y2025).toBe(202500);
    expect(y2023! < y2024!).toBe(true);
    expect(y2024! < y2025!).toBe(true);
  });

  it('correctly parses Quarters and ISO Dates', () => {
    const q1 = parseTemporalSortKey('2024-Q1');
    const q2 = parseTemporalSortKey('2024-Q2');
    const d1 = parseTemporalSortKey('2024-01-15');
    const d2 = parseTemporalSortKey('2024-06-30');

    expect(q1! < q2!).toBe(true);
    expect(d1! < d2!).toBe(true);
  });

  it('returns null for non-temporal entity strings', () => {
    expect(parseTemporalSortKey('France')).toBeNull();
    expect(parseTemporalSortKey('United States')).toBeNull();
    expect(parseTemporalSortKey('Electronics')).toBeNull();
  });

  it('identifies temporal columns by name and sample values', () => {
    expect(isTemporalColumn('MonthLabel', ['2025-11', '2023-08'])).toBe(true);
    expect(isTemporalColumn('Year', [2023, 2024])).toBe(true);
    expect(isTemporalColumn('OrderDate', ['2024-01-15', '2024-02-20'])).toBe(true);
    expect(isTemporalColumn('period', ['2023-Q1', '2023-Q2'])).toBe(true);

    expect(isTemporalColumn('Country', ['France', 'Argentina'])).toBe(false);
    expect(isTemporalColumn('CustomerName', ['Acme Corp', 'Beta LLC'])).toBe(false);
  });

  it('renders all 12 widget visualization kinds without errors', () => {
    const mockData = [
      { Region: 'EMEA', NetRevenue: 1200000 },
      { Region: 'Americas', NetRevenue: 2400000 },
      { Region: 'APAC', NetRevenue: 1800000 },
      { Region: 'LATAM', NetRevenue: 800000 },
    ];
    const mockResult: ExecutionResult = {
      success: true,
      status: 'success',
      data: mockData,
      summary: { metric: 'NetRevenue', aggregation: 'SUM', value: 6200000, formatted_value: '$6.20M' },
      records_matched: 4,
      records_total: 4,
      execution_time_ms: 12.5,
      execution_backend: 'pandas',
    };

    const kinds = [
      'kpi', 'bar', 'horizontal_bar', 'line', 'area',
      'pie', 'donut', 'scatter', 'gauge', 'funnel', 'radar', 'table'
    ];

    for (const kind of kinds) {
      const def: AnalyticsDefinition = {
        id: `widget_${kind}`,
        title: `${kind} widget test`,
        kind,
        revision: 1,
        semantic_revision: 1,
        query_plan: { metric: 'NetRevenue', aggregation: 'SUM', dimension: 'Region' },
        dependencies: ['NetRevenue', 'Region'],
        explanation: 'Test',
        status: 'approved',
      };

      const { container } = render(
        <AnalyticsWidget definition={def} result={mockResult} showTable={false} isDashboard={true} />
      );
      expect(container.firstChild).toBeTruthy();
    }
  });

  it('renders all 12 months for funnel, radar, and horizontal_bar without truncation', () => {
    const twelveMonths = Array.from({ length: 12 }, (_, i) => ({
      Month: '2023-' + String(i + 1).padStart(2, '0'),
      NetRevenue: 30000000 + i * 2000000,
    }));
    const twelveResult: ExecutionResult = {
      success: true,
      data: twelveMonths,
      summary: { metric: 'NetRevenue', aggregation: 'SUM', value: 450000000, formatted_value: '$450.00M' },
      records_matched: 12,
      records_total: 12,
      execution_time_ms: 10,
      execution_backend: 'pandas',
      status: 'success',
      context: { dataset_id: 'test', version: 1, semantic_revision: 1 },
    };

    // 1. Funnel
    const funnelDef: AnalyticsDefinition = {
      id: 'funnel_all_test',
      title: 'Monthly Funnel',
      kind: 'funnel',
      revision: 1,
      semantic_revision: 1,
      query_plan: { metric: 'NetRevenue', aggregation: 'SUM', dimension: 'Month' },
      dependencies: ['NetRevenue', 'Month'],
      explanation: 'Funnel test',
      status: 'approved',
    };
    const { container: funnelContainer } = render(
      <AnalyticsWidget definition={funnelDef} result={twelveResult} showTable={false} />
    );
    // Verifies all 12 polygons/slices exist
    const funnelSlices = funnelContainer.querySelectorAll('polygon');
    expect(funnelSlices.length).toBe(12);

    // 2. Radar
    const radarDef: AnalyticsDefinition = {
      id: 'radar_all_test',
      title: 'Monthly Radar',
      kind: 'radar',
      revision: 1,
      semantic_revision: 1,
      query_plan: { metric: 'NetRevenue', aggregation: 'SUM', dimension: 'Month' },
      dependencies: ['NetRevenue', 'Month'],
      explanation: 'Radar test',
      status: 'approved',
    };
    const { container: radarContainer } = render(
      <AnalyticsWidget definition={radarDef} result={twelveResult} showTable={false} />
    );
    // Verifies 12 vertex points are present on the radar
    const radarDots = radarContainer.querySelectorAll('circle');
    expect(radarDots.length).toBe(12);

    // 3. Horizontal Bar
    const hbarDef: AnalyticsDefinition = {
      id: 'hbar_all_test',
      title: 'Monthly HBar',
      kind: 'horizontal_bar',
      revision: 1,
      semantic_revision: 1,
      query_plan: { metric: 'NetRevenue', aggregation: 'SUM', dimension: 'Month' },
      dependencies: ['NetRevenue', 'Month'],
      explanation: 'HBar test',
      status: 'approved',
    };
    const { container: hbarContainer } = render(
      <AnalyticsWidget definition={hbarDef} result={twelveResult} showTable={false} />
    );
    // Verifies all 12 bars are rendered
    const hbars = hbarContainer.querySelectorAll('rect');
    expect(hbars.length).toBe(12);
  });
});
