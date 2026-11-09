import api from './api';
export const listConnections = async () => (await api.get('/system/connections')).data;
export const connectorTypes = async () => (await api.get('/system/connector-types')).data;
export const listBindings = async () => (await api.get('/system/bindings')).data;
export const listJobs = async () => (await api.get('/system/jobs')).data;

export const SYSTEM_TABS = ['Connections', 'Sync Jobs', 'AI Configuration', 'Storage & Retention', 'Access & Audit'] as const;
