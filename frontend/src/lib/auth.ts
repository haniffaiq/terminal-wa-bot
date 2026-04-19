let credentials: { username: string; password: string } | null = null;

export function setCredentials(username: string, password: string) {
  credentials = { username, password };
}

export function getCredentials() {
  return credentials;
}

export function clearCredentials() {
  credentials = null;
}

export function getAuthHeader(): string | null {
  if (!credentials) return null;
  return 'Basic ' + btoa(`${credentials.username}:${credentials.password}`);
}

export function isAuthenticated(): boolean {
  return credentials !== null;
}
