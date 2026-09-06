// API_BASE: change this if the backend runs somewhere other than localhost:4000
const API_BASE = 'http://192.168.0.62:4000/api';

// The access token lives ONLY in memory (a JS variable), never in
// localStorage. This means it disappears on page refresh — that's
// intentional and handled by silently calling /auth/refresh on load,
// using the httpOnly refresh cookie the browser holds for us.
let accessToken = null;
let currentUser = null;

function setSession(token, user) {
  accessToken = token;
  currentUser = user;
}

function clearSession() {
  accessToken = null;
  currentUser = null;
}

function getCurrentUser() {
  return currentUser;
}

// Wraps fetch: attaches the bearer token, and if the server says the token
// expired, transparently refreshes it once and retries the original request.
async function apiFetch(path, options = {}, isRetry = false) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: 'include', // send/receive the httpOnly refresh cookie
  });

  if (response.status === 401 && !isRetry) {
    const body = await response.clone().json().catch(() => ({}));
    if (body.code === 'TOKEN_EXPIRED') {
      const refreshed = await tryRefresh();
      if (refreshed) return apiFetch(path, options, true);
    }
  }

  return response;
}

async function tryRefresh() {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const data = await res.json();
    accessToken = data.accessToken;
    return true;
  } catch {
    return false;
  }
}

// Call this at the top of every protected page. Tries to restore a session
// from the refresh cookie; if that fails, sends the user back to login.
async function requireSession(allowedRoles = null) {
  if (!accessToken) {
    const refreshed = await tryRefresh();
    if (!refreshed) {
      window.location.href = 'index.html';
      return null;
    }
  }

  const meRes = await apiFetch('/auth/me');
  if (!meRes.ok) {
    window.location.href = 'index.html';
    return null;
  }
  const { user } = await meRes.json();
  currentUser = user;

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    window.location.href = roleHome(user.role);
    return null;
  }

  return user;
}

function roleHome(role) {
  if (role === 'admin') return 'admin.html';
  if (role === 'manager') return 'manager.html';
  return 'employee.html';
}

async function logout() {
  await apiFetch('/auth/logout', { method: 'POST' });
  clearSession();
  window.location.href = 'index.html';
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function formatDuration(startIso, endIso) {
  if (!endIso) return 'In progress';
  const start = new Date(startIso.replace(' ', 'T') + 'Z');
  const end = new Date(endIso.replace(' ', 'T') + 'Z');
  const mins = Math.round((end - start) / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
