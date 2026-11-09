import { hasAdminRole } from './authService';
import api from './api';
import { DatasetItem, DatasetRow, DatasetDataResult } from '../types/dataset';

export async function getDatasets(): Promise<DatasetItem[]> {
  return (await api.get<DatasetItem[]>('/datasets')).data;
}

export async function getDatasetData(datasetId: string, page = 1, pageSize = 10,
  sortField?: string, sortDir: 'asc' | 'desc' = 'asc', searchQuery?: string, version?: number): Promise<DatasetDataResult> {
  const result = (await api.get<DatasetDataResult>(`/datasets/${datasetId}/data`, {
    params: { page, pageSize, sortField, sortDir, search: searchQuery, ...(version ? { version } : {}) },
  })).data;
  return result;
}

export async function updateDatasetRows(datasetId: string, rows: DatasetRow[]) {
  return (await api.put(`/datasets/${datasetId}/rows`, { rows })).data;
}

export async function appendDatasetData(datasetId: string, payload: { rows: DatasetRow[]; file?: File }) {
  const form = new FormData();
  if (payload.file) form.append('file', payload.file);
  form.append('rows', JSON.stringify(payload.rows));
  return (await api.post(`/datasets/${datasetId}/append`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })).data;
}

export async function deleteDatasetRows(datasetId: string, rowIds: string[]) {
  return (await api.delete(`/datasets/${datasetId}/rows`, { data: { rowIds } })).data;
}

export async function deleteDataset(datasetId: string) {
  return (await api.delete(`/datasets/${datasetId}`)).data;
}

export async function rollbackDataset(datasetId: string, version: number) {
  return (await api.post(`/datasets/${datasetId}/rollback`, { version })).data;
}

export async function activateDataset(datasetId: string) {
  return (await api.post(`/datasets/${datasetId}/activate`)).data;
}

export async function reindexDataset(datasetId: string) {
  return (await api.post(`/datasets/${datasetId}/reindex`)).data;
}

export async function getDatasetStatus(datasetId: string, version?: number): Promise<{
  datasetId: string;
  name: string;
  currentVersion: number;
  embeddingStatus: DatasetItem['embeddingStatus'];
  embeddingCount: number;
  hanaSyncStatus: DatasetItem['hanaSyncStatus'];
  rowCount: number;
}> {
  return (await api.get(`/datasets/${datasetId}/status`, { params: version ? { version } : {} })).data;
}

export function getUserPermissions(): {
  canView: boolean;
  canEdit: boolean;
  canAppend: boolean;
  canDelete: boolean;
  role: string;
} {
  try {
    const userJson = typeof localStorage !== 'undefined' ? localStorage.getItem('auth_user') : null;
    if (userJson) {
      const user = JSON.parse(userJson);
      const isAdmin = hasAdminRole(user);
      const roles: string[] = user.roles || (user.role ? [user.role] : []);

      // Member users can see the data across all analytics and explorer pages,
      // but only Administrator accounts can change/mutate data (edit, append, delete, restore).
      return {
        canView: true,
        canEdit: isAdmin,
        canAppend: isAdmin,
        canDelete: isAdmin,
        role: roles[0] || (isAdmin ? 'Administrator' : 'Member'),
      };
    }
  } catch (e) {
    console.error('Error reading user role permissions:', e);
  }

  // Fallback for unauthenticated session: view-only permissions
  return {
    canView: true,
    canEdit: false,
    canAppend: false,
    canDelete: false,
    role: 'Unauthenticated',
  };
}

export async function previewAppendFile(datasetId: string, file: File) {
  const form = new FormData();
  form.append('file', file);
  return (await api.post(`/datasets/${datasetId}/append/preview`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })).data;
}
