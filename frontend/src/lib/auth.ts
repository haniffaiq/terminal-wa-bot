const STORAGE_KEY = 'wa-bot-auth';

function loadCredentials(): { username: string; password: string } | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

let credentials = loadCredentials();

export function setCredentials(username: string, password: string) {
  credentials = { username, password };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(credentials));
}

export function getCredentials() {
  return credentials;
}

export function clearCredentials() {
  credentials = null;
  sessionStorage.removeItem(STORAGE_KEY);
}

export function getAuthHeader(): string | null {
  if (!credentials) return null;
  return 'Basic ' + btoa(`${credentials.username}:${credentials.password}`);
}

export function isAuthenticated(): boolean {
  return credentials !== null;
}
