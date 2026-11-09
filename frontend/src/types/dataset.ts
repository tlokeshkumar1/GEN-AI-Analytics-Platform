export const DATASET_ACTIONS = {
  VIEW: 'view',
  EDIT: 'edit',
  APPEND: 'append',
  DELETE: 'delete',
} as const;

export type DatasetAction = typeof DATASET_ACTIONS[keyof typeof DATASET_ACTIONS];

export interface DatasetColumn {
  name: string;
  type: 'string' | 'number' | 'date' | 'percentage' | 'decimal' | 'identifier' | 'boolean';
  description?: string;
  required?: boolean;
}

export type EmbeddingStatus = 'Ready' | 'Pending' | 'Indexing' | 'Error';
export type HanaSyncStatus = 'Ready' | 'Pending' | 'Error';

export interface DatasetItem {
  id: string;
  name: string;
  description: string;
  rowCount: number;
  columnCount: number;
  lastUpdated: string;
  format: 'xlsx' | 'xls' | 'csv' | 'parquet';
  source: string;
  sizeBytes?: number;
  status: 'Ready' | 'Ingesting' | 'Error';
  columns: DatasetColumn[];
  currentVersion?: number;
  currentFilename?: string;
  versions?: DatasetVersion[];
  embeddingStatus?: EmbeddingStatus;
  embeddingCount?: number;
  hanaSyncStatus?: HanaSyncStatus;
  isActive?: boolean;
}

export interface DatasetVersion {
  version: number;
  filename: string;
  createdAt: string;
  rowCount: number;
  operation: string;
}

export interface DatasetRow {
  id: string;
  [key: string]: any;
}

export interface DatasetDataResult {
  dataset: DatasetItem;
  rows: DatasetRow[];
  totalRows: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AppendValidationResult {
  totalRows: number;
  validRows: DatasetRow[];
  invalidRows: { rowNumber: number; data: Record<string, any>; errors: string[] }[];
  missingColumns: string[];
  extraColumns: string[];
}
