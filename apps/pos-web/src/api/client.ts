// Real HTTP client against the restaurant-erp API -- no mocks, no local
// state standing in for the server. Handles the access/refresh token pair
// Phase 1 issues (15m access, 7d refresh): a 401 triggers exactly one
// refresh attempt (concurrent callers share it instead of each firing
// their own), and only logs the user out if that refresh itself fails.

export class ApiError extends Error {}

// fetch() rejects with a TypeError specifically when the network request
// itself never reached a server (offline, DNS failure, connection refused)
// -- as opposed to ApiError, which means the server WAS reached and
// responded with a real rejection (4xx/5xx). Callers that queue actions
// for offline sync must tell these apart: only a genuine network failure
// should be queued, never a server-side rejection like insufficient stock.
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError;
}

const STORAGE_KEY = 'pos_web_auth_v1';

interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  phone: string;
}

function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuth) : null;
  } catch {
    return null;
  }
}

function persistAuth(auth: StoredAuth | null) {
  try {
    if (auth) localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private-browsing or storage disabled -- session just won't survive a refresh */
  }
}

let authState: StoredAuth | null = loadAuth();
let refreshInFlight: Promise<boolean> | null = null;

// Lets React (AuthContext) know the session ended from INSIDE the api()
// call path (e.g. a 401 whose refresh also failed) without prop-drilling
// a setter down here.
const authChangeListeners = new Set<() => void>();
export function onAuthChange(listener: () => void): () => void {
  authChangeListeners.add(listener);
  return () => authChangeListeners.delete(listener);
}
function notifyAuthChange() {
  authChangeListeners.forEach((l) => l());
}

function apiBase(): string {
  return import.meta.env.VITE_API_BASE_URL.replace(/\/$/, '');
}

export function currentAuth(): StoredAuth | null {
  return authState;
}

export async function login(phone: string, password: string): Promise<StoredAuth> {
  const res = await fetch(apiBase() + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.message || `HTTP ${res.status}`);
  authState = { accessToken: data.accessToken, refreshToken: data.refreshToken, phone };
  persistAuth(authState);
  notifyAuthChange();
  return authState;
}

export function logout() {
  authState = null;
  persistAuth(null);
  notifyAuthChange();
}

async function tryRefresh(): Promise<boolean> {
  if (!authState?.refreshToken) return false;
  const res = await fetch(apiBase() + '/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: authState.refreshToken }),
  });
  if (!res.ok) return false;
  const data = await res.json().catch(() => null);
  if (!data?.accessToken) return false;
  authState = { ...authState, accessToken: data.accessToken };
  persistAuth(authState);
  return true;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const doCall = async () => {
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    if (authState?.accessToken) headers.set('Authorization', `Bearer ${authState.accessToken}`);
    return fetch(apiBase() + path, { ...options, headers });
  };

  let res = await doCall();
  if (res.status === 401 && authState?.refreshToken) {
    if (!refreshInFlight) {
      refreshInFlight = tryRefresh().finally(() => {
        refreshInFlight = null;
      });
    }
    const refreshed = await refreshInFlight;
    if (refreshed) {
      res = await doCall();
    } else {
      logout();
    }
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body, e.g. a 204 -- nothing to parse */
  }

  if (!res.ok) {
    if (res.status === 401) logout();
    const body = data as { message?: string | string[] } | null;
    const message = body?.message ? (Array.isArray(body.message) ? body.message.join('، ') : body.message) : `HTTP ${res.status}`;
    throw new ApiError(message);
  }
  return data as T;
}
