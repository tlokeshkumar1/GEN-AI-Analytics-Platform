import api, { getApiErrorMessage } from './api';

export interface HanaColumn {
  name: string;
  type: string;
  length?: number | null;
  scale?: number | null;
  isNullable?: boolean;
  position?: number;
  defaultValue?: string | null;
  comments?: string | null;
}

export interface HanaTable {
  name: string;
  schema: string;
  type: string;
  rowCount: number;
  columnCount: number;
  columns: HanaColumn[];
  isInternal?: boolean;
}

export interface HanaDatabaseStats {
  connected: boolean;
  host: string;
  port: number;
  schema: string;
  version: string;
  totalTables: number;
  totalRecords: number;
  error?: string;
}

export interface TableDataResponse {
  success: boolean;
  tableName: string;
  totalRows: number;
  filteredRows: number;
  page: number;
  pageSize: number;
  totalPages: number;
  columns: HanaColumn[];
  rows: Record<string, any>[];
}

export interface QueryResultResponse {
  success: boolean;
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  executionTimeMs: number;
  truncated: boolean;
}

/**
 * Fetch database overview including connection stats and all live tables.
 */
export async function getHanaOverview(): Promise<{
  success: boolean;
  status: string;
  stats: HanaDatabaseStats;
  tableCount: number;
  tables: HanaTable[];
}> {
  const res = await api.get('/hanaadmin');
  return res.data;
}

/**
 * Fetch overview statistics for the connected SAP HANA Cloud instance.
 */
export async function getHanaStats(): Promise<HanaDatabaseStats> {
  const res = await api.get('/hanaadmin/stats');
  return res.data;
}

/**
 * Fetch live tables from SAP HANA Cloud schema.
 * Dynamically detects newly created or future tables.
 */
export async function getHanaTables(includeInternal: boolean = true): Promise<HanaTable[]> {
  const res = await api.get('/hanaadmin/tables', {
    params: { include_internal: includeInternal },
  });
  return res.data.tables || [];
}

/**
 * Fetch metadata and column definitions for a specific table.
 */
export async function getHanaTableDetails(tableName: string): Promise<{
  success: boolean;
  tableName: string;
  rowCount: number;
  columnCount: number;
  isInternal: boolean;
  columns: HanaColumn[];
}> {
  const res = await api.get(`/hanaadmin/tables/${encodeURIComponent(tableName)}`);
  return res.data;
}

/**
 * Fetch paginated records from a table with optional search and sorting.
 */
export async function getHanaTableData(
  tableName: string,
  params: {
    page?: number;
    pageSize?: number;
    sortField?: string;
    sortDir?: 'asc' | 'desc';
    search?: string;
  } = {}
): Promise<TableDataResponse> {
  const res = await api.get(`/hanaadmin/tables/${encodeURIComponent(tableName)}/data`, {
    params: {
      page: params.page || 1,
      pageSize: params.pageSize || 25,
      sortField: params.sortField || undefined,
      sortDir: params.sortDir || 'asc',
      search: params.search || '',
    },
  });
  return res.data;
}

/**
 * Execute a read-only SQL SELECT / WITH query against SAP HANA Cloud.
 */
export async function executeHanaQuery(sql: string, maxRows: number = 100): Promise<QueryResultResponse> {
  const res = await api.post('/hanaadmin/query', {
    sql,
    maxRows,
  });
  return res.data;
}

export interface DeleteRangeParams {
  mode: 'row_range' | 'id_range' | 'condition';
  fromRow?: number;
  toRow?: number;
  idColumn?: string;
  fromId?: string;
  toId?: string;
  condition?: string;
}

export interface DeleteRangeResponse {
  success: boolean;
  tableName: string;
  deletedCount: number;
  remainingRows: number;
  message: string;
}

/**
 * Delete a range of records from a table in SAP HANA Cloud.
 */
export async function deleteHanaTableRange(
  tableName: string,
  params: DeleteRangeParams
): Promise<DeleteRangeResponse> {
  const res = await api.post(`/hanaadmin/tables/${encodeURIComponent(tableName)}/delete-range`, params);
  return res.data;
}

