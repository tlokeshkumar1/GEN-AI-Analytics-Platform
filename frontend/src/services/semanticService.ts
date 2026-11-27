import api, { streamingRequestHeaders } from './api';

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
export const getSemanticModels = async (id: string, version: number) => (await api.get<SemanticModel[]>(path(id, version), { timeout: 20_000 })).data;
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
  dataset_id?: string;
  dataset_name?: string;
  source_file?: string;
  table_name?: string;
  version?: number;
}

export interface ExecutionResult {
  success: boolean;
  status?: string;
  data: Record<string, unknown>[];
  summary: Record<string, unknown>;
  records_matched: number;
  records_total?: number;
  execution_time_ms: number;
  error?: string;
  context?: Record<string, unknown>;
  execution_backend: string;
}

export const executePlan = async (plan: Record<string, unknown>, contextHeadersOverride?: Record<string, string>, signal?: AbortSignal) =>
  (await api.post<ExecutionResult>('/insights/execute', plan, { headers: contextHeadersOverride, ...(signal ? { signal, timeout: 90_000 } : {}) })).data;

export const getRecommendations = async (all = false, datasetId?: string) => {
  const params = new URLSearchParams();
  if (all) params.set('all', 'true');
  if (datasetId) params.set('dataset_id', datasetId);
  const query = params.toString();
  return (await api.get<AnalyticsDefinition[]>(query ? `/insights/recommendations?${query}` : '/insights/recommendations')).data;
};

export const proposeRecommendations = async (fast = false) => {
  const url = fast ? '/insights/recommendations?fast=true' : '/insights/recommendations';
  return (await api.post<{ items: AnalyticsDefinition[] }>(url)).data.items;
};

export const saveDefinition = async (item: AnalyticsDefinition) => {
  const { dataset_id, version, dataset_name, source_file, table_name, ...definition } = item;
  const headers: Record<string, string> = {};
  if (dataset_id) headers['X-Dataset-Id'] = dataset_id;
  if (version) headers['X-Dataset-Version'] = String(version);
  if (item.semantic_revision) headers['X-Semantic-Revision'] = String(item.semantic_revision);
  return (await api.post<AnalyticsDefinition>('/insights/definitions', definition, { headers })).data;
};

export const reviewDefinition = async (item: AnalyticsDefinition, decision: 'approved' | 'rejected') => {
  const headers: Record<string, string> = {};
  if (item.dataset_id) headers['X-Dataset-Id'] = item.dataset_id;
  if (item.version) headers['X-Dataset-Version'] = String(item.version);
  if (item.semantic_revision) headers['X-Semantic-Revision'] = String(item.semantic_revision);
  return (await api.post<AnalyticsDefinition>(`/insights/definitions/${item.id}/${item.revision}/review`, { decision }, { headers })).data;
};

export const deleteDefinition = async (item: Pick<AnalyticsDefinition, 'id' | 'revision'> & { dataset_id?: string; version?: number; semantic_revision?: number }) => {
  const headers: Record<string, string> = {};
  if (item.dataset_id) headers['X-Dataset-Id'] = item.dataset_id;
  if (item.version) headers['X-Dataset-Version'] = String(item.version);
  if (item.semantic_revision) headers['X-Semantic-Revision'] = String(item.semantic_revision);
  return (await api.delete<{ deleted: number }>(`/insights/definitions/${item.id}/${item.revision}`, { headers })).data;
};

export const deleteDefinitions = async (items: DashboardPublicationItem[]) =>
  (await api.post<{ deleted: number }>('/insights/definitions/delete', { items })).data;

export interface DashboardPublicationItem {
  id: string;
  revision: number;
  dataset_id?: string;
  version?: number;
  semantic_revision?: number;
}

export interface DashboardPublicationResponse {
  title: string;
  items: DashboardPublicationItem[];
  status: string;
}

export const getDashboardPublication = async (all = false): Promise<DashboardPublicationResponse> => {
  const url = all ? '/insights/dashboard?all=true' : '/insights/dashboard';
  return (await api.get<DashboardPublicationResponse>(url)).data;
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

export interface JoinResolution {
  joinable: boolean;
  left_dataset_id?: string;
  right_dataset_id?: string;
  left_table?: string;
  right_table?: string;
  left_key?: string;
  right_key?: string;
  overlap_count?: number;
  cardinality?: string;
  aggregation_safe?: boolean;
  warning?: string | null;
  reason?: string;
}

export const resolveJoin = async (leftDatasetId: string, rightDatasetId: string): Promise<JoinResolution> => {
  return (await api.post<JoinResolution>('/analytics/resolve-join', {
    left_dataset_id: leftDatasetId,
    right_dataset_id: rightDatasetId
  })).data;
};

export const getJoinGraph = async (): Promise<{ edges: JoinResolution[] }> => {
  return (await api.get<{ edges: JoinResolution[] }>('/analytics/join-graph')).data;
};

// ── Gen AI Dashboard Types & API Methods ────────────────────────────────────

export interface GenAIWorkflowStep {
  step: string;
  name: string;
  detail: string;
  timestamp: number;
  status: 'pending' | 'running' | 'completed' | 'error';
}

export interface GenAISqlInfo {
  sql_query: string;
  join_required: boolean;
  join_type?: string;
  join_rationale?: string;
  join_info?: Record<string, any>;
  records_matched: number;
  records_total: number;
}

export interface GenAIKpiCard {
  query_plan?: Record<string, any>;
  id: string;
  title: string;
  value: number | string;
  metric: string;
  aggregation: string;
  format: 'currency' | 'number' | 'percent' | 'integer';
  subtitle?: string;
}

export interface GenAIChartPoint {
  label: string;
  value: number;
  [key: string]: any;
}

export interface GenAIChart {
  query_plan?: Record<string, any>;
  id: string;
  title: string;
  kind: string;
  metric: string;
  dimension: string;
  aggregation: string;
  data: GenAIChartPoint[];
  total_categories?: number;
  error?: string;
}

export interface GenAIPythonVisual {
  image_base64: string;
  chart_type: string;
  prompt: string;
  verified?: boolean;
  insights?: string;
}

export interface GenAIRecommendation {
  id: string;
  title: string;
  kind: string;
  metric: string;
  dimension?: string;
  aggregation: string;
  rationale: string;
  status?: string;
}

export interface GenAIDashboardResponse {
  context?: { dataset_id: string; version: number; semantic_revision: number };
  status: 'success' | 'error';
  dashboard_id: string;
  prompt: string;
  intent_summary: string;
  execution_time_ms: number;
  workflow_steps: GenAIWorkflowStep[];
  sql_info: GenAISqlInfo;
  kpi_cards: GenAIKpiCard[];
  charts: GenAIChart[];
  python_visual?: GenAIPythonVisual | null;
  executive_insights: string[];
  recommendations: GenAIRecommendation[];
  message?: string;
}

export const generateGenAiDashboard = async (params: {
  prompt: string;
  dataset_id?: string;
  conversation_history?: { role: string; content: string }[];
}): Promise<GenAIDashboardResponse> => {
  const headers: Record<string, string> = {};
  if (params.dataset_id && params.dataset_id !== 'all') {
    headers['X-Dataset-Id'] = params.dataset_id;
  }
  return (
    await api.post<GenAIDashboardResponse>(
      '/graph/genai-dashboard/generate',
      params,
      { headers }
    )
  ).data;
};

export const generateGenAiDashboardStream = async (
  params: {
    prompt: string;
    dataset_id?: string;
    conversation_history?: { role: string; content: string }[];
  },
  onStep?: (step: { step: number; name: string; detail: string; timestamp: number }) => void
): Promise<GenAIDashboardResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...streamingRequestHeaders(params.dataset_id),
    };
    if (params.dataset_id && params.dataset_id !== 'all') {
      headers['X-Dataset-Id'] = params.dataset_id;
    }

    const response = await fetch('/api/graph/genai-dashboard/generate-stream', {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      credentials: 'include',
      signal: controller.signal,
    });

    if ([404, 405].includes(response.status)) {
      return await generateGenAiDashboard(params);
    }
    if (!response.ok || !response.body) throw new Error(`Dashboard request failed (${response.status}).`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: GenAIDashboardResponse | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
            const data = JSON.parse(trimmed.slice(6));
            if (data.type === 'step' && onStep) {
              onStep(data);
            } else if (data.type === 'result') {
              finalResult = data.data;
            } else if (data.type === 'error') {
              throw new Error(data.message || 'Stream processing error');
            }
        }
      }
    }

    if (finalResult?.status === 'success') return finalResult;
    throw new Error(finalResult?.message || 'Dashboard execution ended before completion. Retry explicitly.');
  } catch (err) {
    if (controller.signal.aborted) throw new Error('Dashboard execution exceeded its timeout. Check processing status before retrying.');
    throw err;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
};

export const executeGenAiWidget = async (params: {
  widget: Record<string, any>;
  dataset_id?: string;
  context?: { dataset_id: string; version: number; semantic_revision: number };
}): Promise<{ kind: string; widget: any }> => {
  const headers: Record<string, string> = {};
  if (params.dataset_id && params.dataset_id !== 'all') {
    headers['X-Dataset-Id'] = params.dataset_id;
  }
  if (params.context) {
    headers['X-Dataset-Id'] = params.context.dataset_id;
    headers['X-Dataset-Version'] = String(params.context.version);
    headers['X-Semantic-Revision'] = String(params.context.semantic_revision);
  }
  return (
    await api.post<{ kind: string; widget: any }>(
      '/graph/genai-dashboard/execute-widget',
      params,
      { headers }
    )
  ).data;
};



