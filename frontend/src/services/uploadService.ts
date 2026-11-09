import api from './api';
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

export const uploadDatasetFile = async (
  file: File,
  plan?: Record<string, unknown>,
  targetTableName?: string,
  targetTableAction?: 'create' | 'append' | 'replace' | 'none'
): Promise<UploadResponse> => {
  const formData = new FormData();
  formData.append('file', file);
  if (plan) formData.append('plan', JSON.stringify(plan));
  if (targetTableName) formData.append('target_table_name', targetTableName);
  if (targetTableAction) formData.append('target_table_action', targetTableAction);
  const res = await api.post<UploadResponse>('/upload', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
  });
  return res.data;
};
