import api from './api';

export interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: string;
  tier: string;
  status: 'Active' | 'Inactive' | 'Unknown';
  last_login: string | null;
  origin: string;
  role_collections: string[];
}

export interface ManagedUsersResponse {
  users: ManagedUser[];
  total: number;
  source: 'xsuaa';
  project_role_collections: string[];
  fetched_at: string;
}

export async function fetchManagedUsers(signal?: AbortSignal): Promise<ManagedUsersResponse> {
  const response = await api.get<ManagedUsersResponse>('/users', { signal });
  if (!response.data || !Array.isArray(response.data.users) || response.data.source !== 'xsuaa') {
    throw new Error('The user directory returned an invalid response. Check the API destination and retry.');
  }
  return response.data;
}
