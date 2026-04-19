import { getAuthHeader, clearCredentials } from './auth';

const BASE_URL = '/api';

export async function fetchApi<T = unknown>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const authHeader = getAuthHeader();
  if (!authHeader) {
    throw new Error('Not authenticated');
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    clearCredentials();
    window.location.reload();
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function postApi<T = unknown>(
  endpoint: string,
  body: unknown
): Promise<T> {
  return fetchApi<T>(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function uploadFile(
  endpoint: string,
  formData: FormData
): Promise<unknown> {
  const authHeader = getAuthHeader();
  if (!authHeader) throw new Error('Not authenticated');

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: formData,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}
