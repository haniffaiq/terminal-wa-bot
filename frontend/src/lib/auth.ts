const TOKEN_KEY = 'wa-bot-token';

export interface UserPayload {
  userId: string;
  tenantId: string | null;
  role: 'super_admin' | 'admin';
  brandName: string;
  exp: number;
}

export function setToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

export function getAuthHeader(): string | null {
  const token = getToken();
  if (!token) return null;
  return `Bearer ${token}`;
}

export function getUser(): UserPayload | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) {
      clearToken();
      return null;
    }
    return payload;
  } catch {
    clearToken();
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getUser() !== null;
}

export function isSuperAdmin(): boolean {
  return getUser()?.role === 'super_admin';
}
