// API_BASE: deployed Railway backend.
const API_BASE = 'https://shift-app-production-acbf.up.railway.app/api';

// Keep the short-lived access token in the current tab so login survives the
// redirect to the role page. The refresh token remains httpOnly and cookie-based.
let accessToken = sessionStorage.getItem('shiftAccessToken');
let currentUser = null;

function setSession(token, user) {
  accessToken = token;
  currentUser = user;
  sessionStorage.setItem('shiftAccessToken', token);
}

function clearSession() {
  accessToken = null;
  currentUser = null;
  sessionStorage.removeItem('shiftAccessToken');
}

function getCurrentUser() {
  return currentUser;
}

async function mountNotifications(container) {
  if (!container) return;
  const response = await apiFetch('/users/notifications');
  if (!response.ok) return;
  const data = await response.json();
  container.innerHTML = `<button type="button" class="btn-outline" id="notificationButton">Alerts${data.unreadCount ? ` (${data.unreadCount})` : ''}</button><div id="notificationPanel" class="hidden" style="position:absolute;right:20px;top:58px;z-index:5;background:#fff;border:1px solid #ddd;padding:12px;max-width:360px;box-shadow:0 8px 24px #0002"><strong>Notifications</strong>${data.notifications.length ? data.notifications.map((notification) => `<p data-notification-id="${notification.id}" style="margin:10px 0;${notification.read_at ? '' : 'font-weight:700'}">${notification.title}<br><small>${notification.message}</small></p>`).join('') : '<p>No notifications.</p>'}</div>`;
  const panel = container.querySelector('#notificationPanel');
  container.querySelector('#notificationButton').addEventListener('click', () => panel.classList.toggle('hidden'));
  panel.querySelectorAll('[data-notification-id]').forEach((item) => item.addEventListener('click', async () => {
    await apiFetch(`/users/notifications/${item.dataset.notificationId}/read`, { method: 'PATCH' });
    item.style.fontWeight = '400';
  }));
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
