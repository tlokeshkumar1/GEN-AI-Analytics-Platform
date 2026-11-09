import api from './api';

export interface KPICard {
  title: string;
  value: string;
  change: string;
  trend: 'up' | 'down' | 'neutral';
}

export interface DashboardData {
  kpis: KPICard[];
  revenue_trend: Array<{ month: string; revenue: number; profit: number }>;
  region_breakdown: Array<{ region: string; revenue: number; share: number }>;
  country_breakdown: Array<{ country: string; revenue: number }>;
  category_breakdown: Array<{ category: string; revenue: number }>;
  quarterly_performance: Array<{ quarter: string; target: number; actual: number }>;
  top_products: Array<{ product: string; units: number; revenue: number }>;
}

export const fetchDashboardData = async (): Promise<DashboardData> => {
  const res = await api.get<DashboardData>('/dashboard');
  return res.data;
};
