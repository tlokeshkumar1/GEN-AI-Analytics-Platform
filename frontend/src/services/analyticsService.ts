import api from './api';

export interface AnalyticsResponse {
  query: string;
  generated_sql: string;
  results: Array<Record<string, any>>;
  summary_insights: string;
  insights?: string;
  recommended_chart: string;
  parsing_latency?: number;
  hana_latency?: number;
  records_scanned?: number;
  sql_determinism?: number | string;
}

export const queryAnalytics = async (
  query: string,
  chart_type: string = 'auto'
): Promise<AnalyticsResponse> => {
  const res = await api.post<AnalyticsResponse>('/analytics', { query, chart_type });
  return res.data;
};
