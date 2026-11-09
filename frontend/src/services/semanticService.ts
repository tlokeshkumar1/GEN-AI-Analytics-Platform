import api from './api';

export interface SemanticField {
  name: string;
  semantic_name: string;
  type: string;
  role: string;
  aliases: string[];
  description: string;
  currency?: string | null;
  unit?: string | null;
  aggregations: string[];
  default_aggregation?: string | null;
  evidence: string;
}

export interface SemanticModel {
  dataset_id: string;
  data_version: number;
  revision: number;
  domain: string;
  table_id: string;
  grain: string;
  fields: SemanticField[];
  relationships: unknown[];
  derived_metrics?: unknown[];
  status: 'proposed' | 'approved' | 'rejected';
  reviewer?: string | null;
  reviewed_at?: string | null;
}

const path = (id: string, version: number) => `/datasets/${id}/versions/${version}/semantics`;
export const getSemanticModels = async (id: string, version: number) => (await api.get<SemanticModel[]>(path(id, version))).data;
export const proposeSemanticModel = async (id: string, version: number) => (await api.post<SemanticModel>(`${path(id, version)}/propose`)).data;
export const saveSemanticModel = async (model: SemanticModel) => (await api.post<SemanticModel>(path(model.dataset_id, model.data_version), model)).data;
export const reviewSemanticModel = async (model: SemanticModel, decision: 'approved' | 'rejected') =>
  (await api.post<SemanticModel>(`${path(model.dataset_id, model.data_version)}/${model.revision}/review`, { decision })).data;
export const reuseDefinitions = async (id: string, version: number, sourceVersion: number, revision: number) =>
  (await api.post<{ model: SemanticModel; reused_definitions: number }>(`/datasets/${id}/versions/${version}/reuse`, { source_version: sourceVersion, semantic_revision: revision })).data;

export interface AnalyticsDefinition {
  id: string;
  title: string;
  kind: string;
  revision: number;
  semantic_revision: number;
  query_plan: Record<string, unknown>;
  dependencies: string[];
  explanation: string;
  status: 'proposed' | 'approved' | 'rejected';
  reviewer?: string;
  reviewed_at?: string;
}

export interface ExecutionResult {
  success: boolean;
  status: string;
  data: Record<string, unknown>[];
  summary: Record<string, unknown>;
  records_matched: number;
  records_total: number;
  execution_time_ms: number;
  error?: string;
  context: Record<string, unknown>;
  execution_backend: string;
}

export const executePlan = async (plan: Record<string, unknown>) => (await api.post<ExecutionResult>('/insights/execute', plan)).data;
export const getRecommendations = async () => (await api.get<AnalyticsDefinition[]>('/insights/recommendations')).data;
export const proposeRecommendations = async () => (await api.post<{ items: AnalyticsDefinition[] }>('/insights/recommendations')).data.items;
export const saveDefinition = async (item: AnalyticsDefinition) => (await api.post<AnalyticsDefinition>('/insights/definitions', item)).data;
export const reviewDefinition = async (item: AnalyticsDefinition, decision: 'approved' | 'rejected') =>
  (await api.post<AnalyticsDefinition>(`/insights/definitions/${item.id}/${item.revision}/review`, { decision })).data;

export interface DashboardPublicationItem {
  id: string;
  revision: number;
}

export interface DashboardPublicationResponse {
  title: string;
  items: DashboardPublicationItem[];
  status: string;
}

export const getDashboardPublication = async (): Promise<DashboardPublicationResponse> => {
  return (await api.get<DashboardPublicationResponse>('/insights/dashboard')).data;
};

export interface PythonGraphAgentResponse {
  status: string;
  prompt: string;
  image_base64: string;
  chart_type?: string;
  insights?: string;
  message: string;
  records_matched?: number;
  records_in_source?: number;
  data_as_of?: string;
  verified?: boolean;
  query_plan?: Record<string, any>;
}

export const generatePythonGraphAgent = async (params: {
  prompt?: string;
  query_plan?: Record<string, any>;
  metric?: string;
  dimension?: string;
  chart_type?: string;
  aggregation?: string;
  dataset_id?: string;
}) => {
  const headers: Record<string, string> = {};
  if (params.dataset_id) {
    headers['X-Dataset-Id'] = params.dataset_id;
  }
  return (await api.post<PythonGraphAgentResponse>('/graph/python-agent/generate', params, { headers })).data;
};

