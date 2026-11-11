import axios, { InternalAxiosRequestConfig } from 'axios';
import { contextHeaders } from './executionContext';
import { refreshAuthSession, storeTokenExpiry, TOKEN_EXPIRY_KEY } from './authNavigation';

const api = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem('auth_token') || localStorage.getItem('auth_token');
}

export function setAuthToken(token: string | null, expiresInSeconds?: number | null) {
  if (token) {
    sessionStorage.setItem('auth_token', token);
    localStorage.setItem('auth_token', token);
    api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    if (expiresInSeconds !== undefined) {
      storeTokenExpiry(expiresInSeconds);
    }
  } else {
    sessionStorage.removeItem('auth_token');
    localStorage.removeItem('auth_token');
    storeTokenExpiry(null);
    delete api.defaults.headers.common['Authorization'];
  }
}

export function clearAuthStorage() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem('auth_token');
  sessionStorage.removeItem('auth_user');
  sessionStorage.removeItem(TOKEN_EXPIRY_KEY);
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_user');
  localStorage.removeItem(TOKEN_EXPIRY_KEY);
  delete api.defaults.headers.common['Authorization'];
}

// Initialize default Authorization header from stored token
const existingToken = getStoredToken();
if (existingToken) {
  api.defaults.headers.common['Authorization'] = `Bearer ${existingToken}`;
}

let cachedCsrfToken: string | null = null;

interface ExtendedAxiosRequestConfig extends InternalAxiosRequestConfig {
  _csrfRetried?: boolean;
  _authRetried?: boolean;
}

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  Object.entries(contextHeaders()).forEach(([key, value]) => {
    if (config.headers && typeof (config.headers as any).set === 'function') {
      (config.headers as any).set(key, value);
    } else {
      config.headers[key] = value;
    }
  });

  const token = getStoredToken();
  if (token) {
    if (config.headers && typeof (config.headers as any).set === 'function') {
      (config.headers as any).set('Authorization', `Bearer ${token}`);
    } else {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
  }

  // AppRouter CSRF Token Handling for state-changing requests
  const method = (config.method || 'get').toLowerCase();
  if (method === 'get' || method === 'head') {
    if (config.headers && typeof (config.headers as any).set === 'function') {
      (config.headers as any).set('x-csrf-token', 'Fetch');
    } else {
      config.headers['x-csrf-token'] = 'Fetch';
    }
  } else if (cachedCsrfToken) {
    if (config.headers && typeof (config.headers as any).set === 'function') {
      (config.headers as any).set('x-csrf-token', cachedCsrfToken);
    } else {
      config.headers['x-csrf-token'] = cachedCsrfToken;
    }
  }

  return config;
});

api.interceptors.response.use(
  (response) => {
    // Capture CSRF token from response headers if AppRouter supplies one
    const csrfToken = response.headers['x-csrf-token'];
    if (csrfToken && csrfToken !== 'Required') {
      cachedCsrfToken = csrfToken;
    }

    if (
      typeof response.data === 'string' &&
      (String(response.headers['content-type']).includes('text/html') || /^\s*<(?:!doctype|html)/i.test(response.data))
    ) {
      const message =
        'SAP returned a sign-in page instead of API data. Sign in again; if this repeats, check the application router API destination.';
      throw new axios.AxiosError(
        message,
        'ERR_SAP_SESSION',
        response.config,
        response.request,
        { ...response, status: 401, data: { detail: message } }
      );
    }
    return response;
  },
  async (error) => {
    const originalRequest = error.config as ExtendedAxiosRequestConfig | undefined;

    // Transparent CSRF token fetch & replay on 403 "Required"
    if (
      axios.isAxiosError(error) &&
      error.response?.status === 403 &&
      originalRequest &&
      !originalRequest._csrfRetried
    ) {
      const csrfHeader = error.response.headers?.['x-csrf-token'];
      if (csrfHeader === 'Required' || !cachedCsrfToken) {
        originalRequest._csrfRetried = true;
        try {
          const fetchRes = await axios.get('/api/health', {
            headers: { 'x-csrf-token': 'Fetch' },
            withCredentials: true,
          });
          const freshToken = fetchRes.headers?.['x-csrf-token'];
          if (freshToken && freshToken !== 'Required') {
            cachedCsrfToken = freshToken;
            if (originalRequest.headers && typeof (originalRequest.headers as any).set === 'function') {
              (originalRequest.headers as any).set('x-csrf-token', freshToken);
            } else if (originalRequest.headers) {
              originalRequest.headers['x-csrf-token'] = freshToken;
            }
            return api(originalRequest);
          }
        } catch {
          // If CSRF probe fails, continue with rejection
        }
      }
    }

    if (axios.isAxiosError(error) && error.response?.status === 401) {
      const detail = String(error.response.data?.detail || '');
      const requestUrl = String(originalRequest?.url || '');
      const isAuthMutation =
        requestUrl.includes('/auth/login') ||
        requestUrl.includes('/auth/sso') ||
        requestUrl.includes('/auth/refresh');

      if (
        originalRequest &&
        !originalRequest._authRetried &&
        !isAuthMutation &&
        getStoredToken()
      ) {
        originalRequest._authRetried = true;
        const refreshed = await refreshAuthSession(cachedCsrfToken);
        if (refreshed?.token) {
          setAuthToken(refreshed.token, refreshed.expires_in);
          if (originalRequest.headers && typeof (originalRequest.headers as any).set === 'function') {
            (originalRequest.headers as any).set('Authorization', `Bearer ${refreshed.token}`);
          } else if (originalRequest.headers) {
            originalRequest.headers['Authorization'] = `Bearer ${refreshed.token}`;
          }
          return api(originalRequest);
        }
      }

      if (detail.includes('SAP XSUAA') || detail.includes('Sign in again') || detail.includes('expired') || detail.includes('invalid')) {
        clearAuthStorage();
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
