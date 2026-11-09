import axios from 'axios';
import { contextHeaders } from './executionContext';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

// Initialize default Authorization header from stored token
const existingToken = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
if (existingToken) {
  api.defaults.headers.common['Authorization'] = `Bearer ${existingToken}`;
}

export function setAuthToken(token: string | null) {
  if (token) {
    localStorage.setItem('auth_token', token);
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  } else {
    localStorage.removeItem('auth_token');
    delete api.defaults.headers.common['Authorization'];
  }
}

api.interceptors.request.use((config) => {
  Object.entries(contextHeaders()).forEach(([key, value]) => {
    if (config.headers && typeof (config.headers as any).set === 'function') {
      (config.headers as any).set(key, value);
    } else {
      config.headers[key] = value;
    }
  });
  const token = localStorage.getItem('auth_token');
  if (token) {
    if (config.headers && typeof (config.headers as any).set === 'function') {
      (config.headers as any).set('Authorization', `Bearer ${token}`);
    } else {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (response) => {
    if (typeof response.data === 'string' &&
        (String(response.headers['content-type']).includes('text/html') || /^\s*<(?:!doctype|html)/i.test(response.data))) {
      const message = 'SAP returned a sign-in page instead of API data. Sign in again; if this repeats, check the application router API destination.';
      throw new axios.AxiosError(message, 'ERR_SAP_SESSION', response.config, response.request,
        { ...response, status: 401, data: { detail: message } });
    }
    return response;
  },
  (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      const detail = String(error.response.data?.detail || '');
      if (detail.includes('SAP XSUAA') || detail.includes('Sign in again') || detail.includes('expired') || detail.includes('invalid')) {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
        window.dispatchEvent(new CustomEvent('session-expired', { detail: { message: detail } }));
      }
    }
    return Promise.reject(error);
  }
);

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const detail = error.response?.data?.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail.message === 'string') return detail.message;
    if (status === 401) return 'Your SAP session has expired or is invalid. Sign out and sign in again.';
    if (status === 403) return 'Your SAP account does not have permission for this operation. Check its project role collections.';
    if (status === 404) return 'The requested API or chat session was not found. Check the backend and application router destination.';
    if (status === 500) return 'The analytical engine could not execute this query on the active dataset schema. Please rephrase your natural language question or try structured query mode.';
    if (status === 502 || status === 503 || status === 504) return 'The backend or SAP service is unavailable. Check the backend connection and retry.';
    if (!error.response) return 'The API could not be reached. Check your connection and that the backend is running.';
  }
  return error instanceof Error ? error.message : fallback;
}

export default api;
