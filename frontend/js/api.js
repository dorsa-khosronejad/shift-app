// API_BASE points the deployed frontend at the Railway backend.
const API_BASE = 'https://shift-app-production-de38.up.railway.app/api';

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

// ---------- Offline support ----------
// Queues clock-in/out requests locally when the network is unavailable, and
// replays them in order once the connection returns.
const OFFLINE_QUEUE_KEY = 'shiftOfflineQueue';

function getOfflineQueue() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function setOfflineQueue(queue) {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

function queueOfflineRequest(path, options, label) {
  const queue = getOfflineQueue();
  queue.push({ path, options, label, queuedAt: new Date().toISOString() });
  setOfflineQueue(queue);
  updateSyncStatus();
}

// Attempts the request normally; if the network itself is unavailable
// (not just a non-2xx response), the request is queued instead of thrown.
async function apiFetchOrQueue(path, options, label) {
  try {
    return await apiFetch(path, options);
  } catch (networkError) {
    queueOfflineRequest(path, options, label);
    return null;
  }
}

async function syncOfflineQueue() {
  const remaining = getOfflineQueue();
  while (remaining.length) {
    try {
      await apiFetch(remaining[0].path, remaining[0].options);
      remaining.shift();
    } catch {
      break; // still offline; keep the rest queued for the next attempt
    }
  }
  setOfflineQueue(remaining);
  updateSyncStatus();
  return remaining.length === 0;
}

function updateSyncStatus() {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const pending = getOfflineQueue().length;
  if (!navigator.onLine) {
    el.textContent = pending ? `Offline — ${pending} shift update(s) will sync automatically when you're back online.` : "Offline — clock actions will be saved and synced automatically.";
  } else if (pending) {
    el.textContent = `Syncing ${pending} shift update(s)…`;
  } else {
    el.textContent = '';
  }
}

window.addEventListener('online', syncOfflineQueue);
window.addEventListener('offline', updateSyncStatus);


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

async function mountNotifications(container) {
  if (!container) return;
  const response = await apiFetch('/users/notifications');
  if (!response.ok) return;
  const { notifications, unreadCount } = await response.json();
  container.innerHTML = unreadCount
    ? `<span class="notification-count" title="${notifications.filter((item) => !item.read_at).map((item) => item.title).join(', ')}">${unreadCount} new</span>`
    : '';
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
