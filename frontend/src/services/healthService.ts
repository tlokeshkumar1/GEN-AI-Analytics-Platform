import api from './api';

export interface HealthResponse {
  status: string;
  app_name: string;
  version: string;
  hana_connected: boolean;
  ai_core_connected: boolean | null;
  ai_core_configured?: boolean;
}

export const fetchHealthStatus = async (): Promise<HealthResponse> => {
  const res = await api.get<HealthResponse>('/health');
  return res.data;
};
