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
  source: 'xsuaa' | 'local_dev';
  project_role_collections: string[];
  fetched_at: string;
}

export async function fetchManagedUsers(signal?: AbortSignal, refresh: boolean = false): Promise<ManagedUsersResponse> {
  const url = refresh ? '/users?refresh=true' : '/users';
  const response = await api.get<ManagedUsersResponse>(url, { signal });
  if (!response.data || !Array.isArray(response.data.users) || (response.data.source !== 'xsuaa' && (response.data.source as string) !== 'local_dev')) {
    throw new Error('The user directory returned an invalid response. Check the API destination and retry.');
  }
  return response.data;
}
