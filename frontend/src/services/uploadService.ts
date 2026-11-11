import api from './api';
import { invalidateDatasetsCache } from './datasetService';
import { contextHeaders } from './executionContext';
import { DatasetItem } from '../types/dataset';

export interface CloudTableColumn {
  name: string;
  type: string;
  length?: number;
  scale?: number;
}

export interface CloudTableInfo {
  name: string;
  schema?: string;
  type: string;
  rowCount: number;
  columnCount: number;
  columns: CloudTableColumn[];
}

export interface UploadResponse {
  status: string;
  filename: string;
  rows_processed: number;
  embeddings_generated: number;
  message: string;
  dataset?: DatasetItem;
  version?: number;
  embedding_status?: string;
  cloud_table?: {
    success: boolean;
    table_name: string;
    rows_inserted?: number;
    action?: string;
    error?: string;
    message?: string;
  };
  preprocessing_audit?: {
    rows_before?: number;
    rows_after?: number;
    duplicates_removed?: number;
    null_values_cleaned?: number;
    message?: string;
    null_fixes_by_column?: Record<string, number>;
  };
  domain?: string;
  semantic_model?: Record<string, any>;
  recommendations?: Array<{
    id: string;
    title: string;
    kind: string;
    query_plan: Record<string, any>;
    explanation: string;
    selected_by_default: boolean;
    preview_value?: string;
    preview_rows?: Array<Record<string, any>>;
  }>;
}

export const getDatabaseTables = async (): Promise<{ tables: CloudTableInfo[] }> => {
  const res = await api.get<{ tables: CloudTableInfo[] }>('/database/tables');
  return res.data;
};

export interface UploadStageEvent {
  type: 'stage';
  stage: number;
  status: 'running' | 'completed' | 'failed';
  message: string;
  data?: Partial<UploadResponse>;
}

const buildUploadFormData = (
  file: File,
  plan?: Record<string, unknown>,
  targetTableName?: string,
  targetTableAction?: 'create' | 'append' | 'replace' | 'none'
): FormData => {
  const formData = new FormData();
  formData.append('file', file);
  if (plan) formData.append('plan', JSON.stringify(plan));
  if (targetTableName) formData.append('target_table_name', targetTableName);
  if (targetTableAction) formData.append('target_table_action', targetTableAction);
  return formData;
};

export const uploadDatasetFile = async (
  file: File,
  plan?: Record<string, unknown>,
  targetTableName?: string,
  targetTableAction?: 'create' | 'append' | 'replace' | 'none'
): Promise<UploadResponse> => {
  const formData = buildUploadFormData(file, plan, targetTableName, targetTableAction);
  const res = await api.post<UploadResponse>('/upload', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
  invalidateDatasetsCache();
  return res.data;
};

export const uploadDatasetFileStream = async (
  file: File,
  plan: Record<string, unknown> | undefined,
  targetTableName: string | undefined,
  targetTableAction: 'create' | 'append' | 'replace' | 'none' | undefined,
  onStage: (event: UploadStageEvent) => void
): Promise<UploadResponse> => {
  const buildHeaders = (csrfToken?: string | null): Record<string, string> => {
    const headers: Record<string, string> = { ...contextHeaders() };
    const token =
      typeof window !== 'undefined'
        ? sessionStorage.getItem('auth_token') || localStorage.getItem('auth_token')
        : null;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (csrfToken) {
      headers['x-csrf-token'] = csrfToken;
    }
    return headers;
  };

  const postStream = (csrfToken?: string | null) =>
    fetch('/api/upload/stream', {
      method: 'POST',
      headers: buildHeaders(csrfToken),
      credentials: 'same-origin',
      body: buildUploadFormData(file, plan, targetTableName, targetTableAction),
    });

  let response = await postStream();
  if (response.status === 403 && response.headers.get('x-csrf-token') === 'Required') {
    const csrfRes = await fetch('/api/health', {
      headers: { 'x-csrf-token': 'Fetch' },
      credentials: 'same-origin',
    });
    const freshToken = csrfRes.headers.get('x-csrf-token');
    if (freshToken && freshToken !== 'Required') {
      response = await postStream(freshToken);
    }
  }

  if (response.status === 404 || !response.body) {
    return uploadDatasetFile(file, plan, targetTableName, targetTableAction);
  }

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const detail = typeof data?.detail === 'string' ? data.detail : `Upload failed (HTTP ${response.status}).`;
    throw new Error(detail);
  }

  if (response.headers.get('content-type')?.includes('text/html')) {
    throw new Error('SAP returned a sign-in page instead of API data. Sign in again and retry.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: UploadResponse | null = null;

  const processBlock = (block: string) => {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line.startsWith('data: ')) continue;
      const parsed = JSON.parse(line.substring(6));
      if (parsed.type === 'stage') {
        onStage(parsed as UploadStageEvent);
      } else if (parsed.type === 'result' && parsed.data) {
        finalResult = parsed.data as UploadResponse;
      } else if (parsed.type === 'error') {
        throw new Error(parsed.message || 'Import failed.');
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      processBlock(block);
    }
  }

  if (buffer.trim()) {
    processBlock(buffer);
  }

  if (!finalResult) {
    throw new Error('Upload stream completed without returning a dataset result.');
  }

  invalidateDatasetsCache();
  return finalResult;
};
