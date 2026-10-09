const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, before, test } = require('node:test');
const Database = require('better-sqlite3');

let tempDir;
let server;
let fixtureDb;
let databasePath;
const port = 4200 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}/api`;
const sessions = new Map();
let invitedEmployee;
let invitedManager;

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function requestAt(apiBaseUrl, pathname, options = {}) {
  const url = `${apiBaseUrl}${pathname}`;
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function loginSession(email, password, { cache = true } = {}) {
  const cacheKey = `${email}:${password}`;
  if (cache && sessions.has(cacheKey)) return sessions.get(cacheKey);
  const result = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200);
  const setCookie = result.response.headers.get('set-cookie');
  const session = {
    accessToken: result.body.accessToken,
    cookie: setCookie?.split(';', 1)[0],
    setCookie,
  };
  if (cache) sessions.set(cacheKey, session);
  return session;
}

async function login(email, password) {
  return (await loginSession(email, password)).accessToken;
}

function authHeaders(token, body) {
  return {
    authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
}

async function jsonRequest(pathname, method, token, body, headers = {}) {
  return request(pathname, {
    method,
    headers: { ...authHeaders(token, body), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function seedOneTimeToken(table, userId, expiresAt = new Date(Date.now() + 60000).toISOString()) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  fixtureDb.prepare(`INSERT INTO ${table} (user_id, token_hash, expires_at) VALUES (?, ?, ?)`).run(userId, tokenHash, expiresAt);
  return rawToken;
}

function totpCode(secret, timestamp = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const key = [];
  for (const character of secret) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timestamp / 30000)));
  const digest = crypto.createHmac('sha1', Buffer.from(key)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}

async function waitForReady() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const result = await request('/ready');
      if (result.response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server did not become ready');
}

async function startAuxServer() {
  const auxPort = 5000 + Math.floor(Math.random() * 1000);
  const auxBaseUrl = `http://127.0.0.1:${auxPort}/api`;
  const auxServer = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(auxPort),
      DB_PATH: databasePath,
      CORS_ORIGIN: 'http://localhost:5500',
      JWT_ACCESS_SECRET: 'test-access-secret-1234567890abcdefghijklmnopqrstuv',
      JWT_REFRESH_SECRET: 'test-refresh-secret-1234567890abcdefghijklmnop',
      NODE_ENV: 'test',
      SMTP_HOST: '',
      FRONTEND_URL: 'http://localhost:5500',
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const ready = await requestAt(auxBaseUrl, '/ready');
      if (ready.response.status === 200) {
        return {
          baseUrl: auxBaseUrl,
          async stop() {
            if (auxServer.exitCode === null) {
              const exited = new Promise((resolve) => auxServer.once('exit', resolve));
              auxServer.kill('SIGTERM');
              await exited;
            }
          },
        };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  auxServer.kill('SIGTERM');
  throw new Error('Auxiliary test server did not become ready');
}

function dateOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-api-'));
  databasePath = path.join(tempDir, 'shifts.db');
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: databasePath,
      CORS_ORIGIN: 'http://localhost:5500',
      JWT_ACCESS_SECRET: 'test-access-secret-1234567890abcdefghijklmnopqrstuv',
      JWT_REFRESH_SECRET: 'test-refresh-secret-1234567890abcdefghijklmnop',
      NODE_ENV: 'test',
      SMTP_HOST: '',
      FRONTEND_URL: 'http://localhost:5500',
    },
    stdio: 'ignore',
  });
  await waitForReady();
  fixtureDb = new Database(databasePath);
});

after(async () => {
  fixtureDb?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('authentication validates credentials and rotates then revokes refresh tokens', async () => {
  const malformed = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', password: '' }),
  });
  assert.equal(malformed.response.status, 400);

  const wrongPassword = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'employee@demo.local', password: 'Wrong123!' }),
  });
  const unknownUser = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'missing@demo.local', password: 'Wrong123!' }),
  });
  assert.equal(wrongPassword.response.status, 401);
  assert.deepEqual(wrongPassword.body, unknownUser.body);

  const noRefreshToken = await request('/auth/refresh', { method: 'POST' });
  assert.equal(noRefreshToken.response.status, 401);

  const session = await loginSession('employee@demo.local', 'Employee123!');
  assert.match(session.cookie, /^refreshToken=/);
  assert.match(session.setCookie, /HttpOnly/i);
  assert.match(session.setCookie, /SameSite=Strict/i);
  const loginHistory = await request('/auth/login-history', { headers: authHeaders(session.accessToken) });
  assert.equal(loginHistory.response.status, 200);
  assert.ok(loginHistory.body.history.length >= 1);

  const employeeId = fixtureDb.prepare('SELECT id FROM users WHERE email = ?').get('employee@demo.local').id;
  const expiredRefresh = crypto.randomBytes(32).toString('hex');
  fixtureDb.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    employeeId,
    crypto.createHash('sha256').update(expiredRefresh).digest('hex'),
    '2000-01-01T00:00:00.000Z'
  );
  assert.equal((await request('/auth/refresh', { method: 'POST', headers: { cookie: `refreshToken=${expiredRefresh}` } })).response.status, 401);

  const refreshed = await request('/auth/refresh', {
    method: 'POST',
    headers: { cookie: session.cookie },
  });
  assert.equal(refreshed.response.status, 200);
  assert.ok(refreshed.body.accessToken);
  const rotatedCookie = refreshed.response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.match(rotatedCookie, /^refreshToken=/);

  const reusedToken = await request('/auth/refresh', {
    method: 'POST',
    headers: { cookie: session.cookie },
  });
  assert.equal(reusedToken.response.status, 401);

  const logout = await request('/auth/logout', {
    method: 'POST',
    headers: { cookie: rotatedCookie },
  });
  assert.equal(logout.response.status, 200);
  const loggedOutRefresh = await request('/auth/refresh', {
    method: 'POST',
    headers: { cookie: rotatedCookie },
  });
  assert.equal(loggedOutRefresh.response.status, 401);
});

test('readiness, login, role protection, and schedule conflict handling', async () => {
  const managerToken = await login('manager@demo.local', 'Manager123!');
  const employeeToken = await login('employee@demo.local', 'Employee123!');

  const ready = await request('/ready');
  assert.equal(ready.body.status, 'ready');
  const health = await request('/health');
  assert.deepEqual(health.body, { status: 'ok' });

  const csrfBlocked = await request('/auth/logout', {
    method: 'POST',
    headers: { origin: 'https://malicious.example' },
  });
  assert.equal(csrfBlocked.response.status, 403);

  const staff = await request('/users/staff', {
    headers: { authorization: `Bearer ${managerToken}` },
  });
  assert.equal(staff.response.status, 200);
  const employeeId = staff.body.users[0].id;

  const created = await request('/shifts/schedule', {
    method: 'POST',
    headers: { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ employeeId, shiftDate: '2030-01-10', startTime: '09:00', endTime: '17:00' }),
  });
  assert.equal(created.response.status, 201);

  const conflict = await request('/shifts/schedule', {
    method: 'POST',
    headers: { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ employeeId, shiftDate: '2030-01-10', startTime: '10:00', endTime: '12:00' }),
  });
  assert.equal(conflict.response.status, 409);

  const employeeMutation = await request('/shifts/schedule', {
    method: 'POST',
    headers: { authorization: `Bearer ${employeeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ employeeId, shiftDate: '2030-01-11', startTime: '09:00', endTime: '17:00' }),
  });
  assert.equal(employeeMutation.response.status, 403);
});

test('employees can claim open shifts once, while managers cannot claim them', async () => {
  const managerToken = await login('manager@demo.local', 'Manager123!');
  const employeeToken = await login('employee@demo.local', 'Employee123!');
  const managerHeaders = { authorization: `Bearer ${managerToken}`, 'content-type': 'application/json' };
  const employeeHeaders = { authorization: `Bearer ${employeeToken}` };

  const created = await request('/shifts/open-shifts', {
    method: 'POST',
    headers: managerHeaders,
    body: JSON.stringify({ shiftDate: '2099-01-10', startTime: '09:00', endTime: '17:00' }),
  });
  assert.equal(created.response.status, 201);

  const available = await request('/shifts/open-shifts', { headers: employeeHeaders });
  const openShift = available.body.openShifts.find((shift) => shift.id === created.body.id);
  assert.ok(openShift);

  const managerClaim = await request(`/shifts/open-shifts/${created.body.id}/claim`, {
    method: 'POST',
    headers: { authorization: `Bearer ${managerToken}` },
  });
  assert.equal(managerClaim.response.status, 403);

  const claim = await request(`/shifts/open-shifts/${created.body.id}/claim`, {
    method: 'POST',
    headers: employeeHeaders,
  });
  assert.equal(claim.response.status, 200);

  const duplicateClaim = await request(`/shifts/open-shifts/${created.body.id}/claim`, {
    method: 'POST',
    headers: employeeHeaders,
  });
  assert.equal(duplicateClaim.response.status, 409);

  const mySchedule = await request('/shifts/schedule/mine?from=2099-01-10', { headers: employeeHeaders });
  assert.ok(mySchedule.body.schedules.some((schedule) => schedule.shift_date === '2099-01-10'));

  const conflictingShift = await request('/shifts/open-shifts', {
    method: 'POST',
    headers: managerHeaders,
    body: JSON.stringify({ shiftDate: '2099-01-10', startTime: '10:00', endTime: '12:00' }),
  });
  assert.equal(conflictingShift.response.status, 201);

  const conflictClaim = await request(`/shifts/open-shifts/${conflictingShift.body.id}/claim`, {
    method: 'POST',
    headers: employeeHeaders,
  });
  assert.equal(conflictClaim.response.status, 409);
});

test('registration, invite acceptance, and admin account controls follow role and one-time rules', async () => {
  const adminToken = await login('admin@demo.local', 'Admin123!');
  const managerToken = await login('manager@demo.local', 'Manager123!');
  const adminId = fixtureDb.prepare('SELECT id FROM users WHERE email = ?').get('admin@demo.local').id;

  const managerRegistration = await jsonRequest('/auth/register', 'POST', managerToken, {
    name: 'Blocked Account', email: 'blocked@example.test', password: 'Valid123!', role: 'employee',
  });
  assert.equal(managerRegistration.response.status, 403);

  const invalidRegistration = await jsonRequest('/auth/register', 'POST', adminToken, {
    name: 'A', email: 'bad-email', password: 'short', role: 'unknown',
  });
  assert.equal(invalidRegistration.response.status, 400);

  const registered = await jsonRequest('/auth/register', 'POST', adminToken, {
    name: 'Registered Staff', email: 'registered.staff@example.test', password: 'Registered123!', role: 'employee', department: 'Front Desk',
  });
  assert.equal(registered.response.status, 201);
  const duplicateRegistration = await jsonRequest('/auth/register', 'POST', adminToken, {
    name: 'Registered Staff', email: 'registered.staff@example.test', password: 'Registered123!', role: 'employee',
  });
  assert.equal(duplicateRegistration.response.status, 409);

  const inviteForbidden = await jsonRequest('/auth/invites', 'POST', managerToken, {
    email: 'invited@example.test', role: 'employee',
  });
  assert.equal(inviteForbidden.response.status, 403);
  const invalidInvite = await jsonRequest('/auth/invites', 'POST', adminToken, {
    email: 'not-an-email', role: 'employee',
  });
  assert.equal(invalidInvite.response.status, 400);

  const invite = await jsonRequest('/auth/invites', 'POST', adminToken, {
    email: 'invited.employee@example.test', role: 'employee', department: 'Night Audit',
  });
  assert.equal(invite.response.status, 201);
  const inviteToken = new URL(invite.body.link).searchParams.get('invite');
  assert.match(inviteToken, /^[a-f0-9]{64}$/);
  const inviteList = await request('/auth/invites', { headers: authHeaders(adminToken) });
  assert.ok(inviteList.body.invites.some((item) => item.email === 'invited.employee@example.test'));
  assert.equal((await request('/auth/invites', { headers: authHeaders(managerToken) })).response.status, 403);

  const badAcceptance = await request('/auth/invites/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: inviteToken, firstName: 'I', familyName: 'Employee', businessId: 'INV-EMP-01', phone: '+15555550123', password: 'Password123!' }),
  });
  assert.equal(badAcceptance.response.status, 400);

  const acceptanceData = {
    token: inviteToken, firstName: 'Ira', familyName: 'Employee', businessId: 'INV-EMP-01',
    phone: '+15555550123', password: 'Invited123!',
  };
  const acceptance = await jsonRequest('/auth/invites/accept', 'POST', undefined, acceptanceData);
  assert.equal(acceptance.response.status, 201);
  invitedEmployee = await loginSession('invited.employee@example.test', 'Invited123!');
  const reusedInvite = await jsonRequest('/auth/invites/accept', 'POST', undefined, acceptanceData);
  assert.equal(reusedInvite.response.status, 401);

  const users = await request('/users', { headers: authHeaders(adminToken) });
  invitedEmployee.id = users.body.users.find((user) => user.email === 'invited.employee@example.test').id;
  assert.ok(users.body.users.some((user) => user.id === registered.body.id));
  assert.equal((await request('/users', { headers: authHeaders(managerToken) })).response.status, 403);
  const staff = await request('/users/staff', { headers: authHeaders(managerToken) });
  assert.ok(staff.body.users.some((user) => user.id === invitedEmployee.id));
  assert.equal((await request('/users/staff', { headers: authHeaders(invitedEmployee.accessToken) })).response.status, 403);

  assert.equal((await jsonRequest(`/users/${registered.body.id}/status`, 'PATCH', adminToken, { is_active: 'yes' })).response.status, 400);
  assert.equal((await jsonRequest(`/users/${adminId}/status`, 'PATCH', adminToken, { is_active: false })).response.status, 400);
  assert.equal((await jsonRequest(`/users/${registered.body.id}/role`, 'PATCH', managerToken, { role: 'manager' })).response.status, 403);
  assert.equal((await jsonRequest(`/users/${registered.body.id}/role`, 'PATCH', adminToken, { role: 'owner' })).response.status, 400);
  assert.equal((await jsonRequest(`/users/${adminId}/role`, 'PATCH', adminToken, { role: 'employee' })).response.status, 400);

  assert.equal((await jsonRequest(`/users/${registered.body.id}/status`, 'PATCH', adminToken, { is_active: false })).response.status, 200);
  assert.equal((await jsonRequest('/users/999999/status', 'PATCH', adminToken, { is_active: false })).response.status, 404);
  assert.equal((await request('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'registered.staff@example.test', password: 'Registered123!' }),
  })).response.status, 401);
  assert.equal((await jsonRequest(`/users/${registered.body.id}/status`, 'PATCH', adminToken, { is_active: true })).response.status, 200);
  assert.equal((await jsonRequest(`/users/${registered.body.id}/role`, 'PATCH', adminToken, { role: 'manager' })).response.status, 200);

  const managerInvite = await jsonRequest('/auth/invites', 'POST', adminToken, {
    email: 'invited.manager@example.test', role: 'manager',
  });
  const managerInviteToken = new URL(managerInvite.body.link).searchParams.get('invite');
  const managerAccept = await jsonRequest('/auth/invites/accept', 'POST', undefined, {
    token: managerInviteToken, firstName: 'Morgan', familyName: 'Manager', businessId: 'INV-MGR-01',
    phone: '+15555550124', password: 'ManagerInvited123!',
  });
  assert.equal(managerAccept.response.status, 201);
  invitedManager = await loginSession('invited.manager@example.test', 'ManagerInvited123!');
  invitedManager.id = (await request('/users', { headers: authHeaders(adminToken) })).body.users
    .find((user) => user.email === 'invited.manager@example.test').id;
});

test('2FA, email verification, and password reset enforce valid and one-time tokens', async () => {
  const employeeToken = await login('employee@demo.local', 'Employee123!');
  const initialStatus = await request('/auth/2fa/status', { headers: authHeaders(employeeToken) });
  assert.equal(initialStatus.body.enabled, false);

  const setup = await jsonRequest('/auth/2fa/setup', 'POST', employeeToken, {});
  assert.equal(setup.response.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]+$/);
  assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.equal((await jsonRequest('/auth/2fa/enable', 'POST', employeeToken, { code: 'bad' })).response.status, 400);
  const otp = totpCode(setup.body.secret);
  assert.equal((await jsonRequest('/auth/2fa/enable', 'POST', employeeToken, { code: otp })).response.status, 200);

  const challengeResponse = await request('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'employee@demo.local', password: 'Employee123!' }),
  });
  assert.equal(challengeResponse.response.status, 401);
  assert.equal(challengeResponse.body.code, 'TWO_FACTOR_REQUIRED');
  const challenge = challengeResponse.body.challenge;
  const twoFactorLogin = await request('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'employee@demo.local', password: 'Employee123!', challenge, otp: totpCode(setup.body.secret) }),
  });
  assert.equal(twoFactorLogin.response.status, 200);
  assert.equal(twoFactorLogin.body.user.twoFactorEnabled, true);
  const replayedChallenge = await request('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'employee@demo.local', password: 'Employee123!', challenge, otp: totpCode(setup.body.secret) }),
  });
  assert.equal(replayedChallenge.response.status, 401);
  assert.notEqual(replayedChallenge.body.challenge, challenge);

  assert.equal((await jsonRequest('/auth/2fa/disable', 'POST', employeeToken, { currentPassword: 'bad', code: otp })).response.status, 401);
  assert.equal((await jsonRequest('/auth/2fa/disable', 'POST', employeeToken, { currentPassword: 'Employee123!', code: otp })).response.status, 200);
  assert.equal((await request('/auth/2fa/status', { headers: authHeaders(employeeToken) })).body.enabled, false);

  const verifyUserId = fixtureDb.prepare('SELECT id FROM users WHERE email = ?').get('invited.employee@example.test').id;
  const verifyToken = seedOneTimeToken('email_verification_tokens', verifyUserId);
  const invalidVerify = await jsonRequest('/auth/verify-email', 'POST', undefined, { token: 'invalid' });
  assert.equal(invalidVerify.response.status, 400);
  const verified = await jsonRequest('/auth/verify-email', 'POST', undefined, { token: verifyToken });
  assert.equal(verified.response.status, 200);
  assert.equal((await jsonRequest('/auth/verify-email', 'POST', undefined, { token: verifyToken })).response.status, 401);
  const expiredVerifyToken = seedOneTimeToken('email_verification_tokens', verifyUserId, '2000-01-01T00:00:00.000Z');
  assert.equal((await jsonRequest('/auth/verify-email', 'POST', undefined, { token: expiredVerifyToken })).response.status, 401);

  const resetToken = seedOneTimeToken('password_reset_tokens', verifyUserId);
  assert.equal((await jsonRequest('/auth/reset-password', 'POST', undefined, { token: resetToken, newPassword: 'short' })).response.status, 400);
  const reset = await jsonRequest('/auth/reset-password', 'POST', undefined, { token: resetToken, newPassword: 'ResetNow123!' });
  assert.equal(reset.response.status, 200);
  assert.equal((await jsonRequest('/auth/reset-password', 'POST', undefined, { token: resetToken, newPassword: 'ResetAgain123!' })).response.status, 401);
  const oldPassword = await request('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'invited.employee@example.test', password: 'Invited123!' }),
  });
  assert.equal(oldPassword.response.status, 401);
  assert.equal((await loginSession('invited.employee@example.test', 'ResetNow123!', { cache: false })).accessToken.length > 0, true);
});

test('profile, notifications, wellbeing privacy, and audit access follow user scope', async () => {
  const employeeToken = await login('employee@demo.local', 'Employee123!');
  const managerToken = await login('manager@demo.local', 'Manager123!');
  const adminToken = await login('admin@demo.local', 'Admin123!');

  assert.equal((await request('/users/me')).response.status, 401);
  assert.equal((await request('/auth/me', { headers: { authorization: 'Bearer invalid' } })).response.status, 401);
  const authMe = await request('/auth/me', { headers: authHeaders(employeeToken) });
  assert.equal(authMe.body.user.email, 'employee@demo.local');
  const userMe = await request('/users/me', { headers: authHeaders(employeeToken) });
  assert.equal(userMe.body.user.id, authMe.body.user.id);

  assert.equal((await jsonRequest('/users/me', 'PATCH', employeeToken, { phone: 'x'.repeat(41) })).response.status, 400);
  assert.equal((await jsonRequest('/users/me', 'PATCH', employeeToken, { phone: '+15555550125', businessId: 'EMP-TEST-01' })).response.status, 200);
  const updatedProfile = await request('/users/me', { headers: authHeaders(employeeToken) });
  assert.equal(updatedProfile.body.user.phone, '+15555550125');
  assert.equal(updatedProfile.body.user.businessId, 'EMP-TEST-01');

  const reportInvalid = await jsonRequest('/users/wellbeing-reports', 'POST', employeeToken, {
    category: 'medical', description: 'Short',
  });
  assert.equal(reportInvalid.response.status, 400);
  const report = await jsonRequest('/users/wellbeing-reports', 'POST', employeeToken, {
    category: 'workload', description: 'Repeated understaffing during evening shifts', isAnonymous: true,
  });
  assert.equal(report.response.status, 201);
  const mine = await request('/users/wellbeing-reports/mine', { headers: authHeaders(employeeToken) });
  assert.ok(mine.body.reports.some((item) => item.id === report.body.id));

  assert.equal((await request('/users/wellbeing-reports', { headers: authHeaders(employeeToken) })).response.status, 403);
  assert.equal((await request('/users/wellbeing-reports/trends', { headers: authHeaders(employeeToken) })).response.status, 403);
  const managerReports = await request('/users/wellbeing-reports', { headers: authHeaders(managerToken) });
  const anonymousReport = managerReports.body.reports.find((item) => item.id === report.body.id);
  assert.equal(anonymousReport.user_name, 'Anonymous');
  assert.equal(anonymousReport.department, null);
  assert.equal((await jsonRequest(`/users/wellbeing-reports/${report.body.id}/status`, 'PATCH', employeeToken, { status: 'resolved' })).response.status, 403);
  assert.equal((await jsonRequest(`/users/wellbeing-reports/${report.body.id}/status`, 'PATCH', managerToken, { status: 'closed' })).response.status, 400);
  assert.equal((await jsonRequest(`/users/wellbeing-reports/${report.body.id}/status`, 'PATCH', managerToken, { status: 'acknowledged', response: 'Manager has reviewed this report.' })).response.status, 200);
  assert.equal((await jsonRequest('/users/wellbeing-reports/999999/status', 'PATCH', managerToken, { status: 'resolved' })).response.status, 404);
  const trends = await request('/users/wellbeing-reports/trends', { headers: authHeaders(managerToken) });
  assert.ok(trends.body.byCategory.some((item) => item.category === 'workload' && item.total >= 1));

  const notifications = await request('/users/notifications', { headers: authHeaders(employeeToken) });
  assert.ok(notifications.body.notifications.length >= 1);
  const unread = notifications.body.notifications.find((item) => !item.read_at);
  assert.ok(unread);
  assert.equal((await jsonRequest(`/users/notifications/${unread.id}/read`, 'PATCH', managerToken, {})).response.status, 200);
  const stillUnread = await request('/users/notifications', { headers: authHeaders(employeeToken) });
  assert.equal(stillUnread.body.notifications.find((item) => item.id === unread.id).read_at, null);
  assert.equal((await jsonRequest(`/users/notifications/${unread.id}/read`, 'PATCH', employeeToken, {})).response.status, 200);
  const employeeNotifications = await request('/users/notifications', { headers: authHeaders(employeeToken) });
  assert.ok(employeeNotifications.body.notifications.find((item) => item.id === unread.id).read_at);
  assert.equal((await request('/users/audit-log', { headers: authHeaders(managerToken) })).response.status, 403);
  const audit = await request('/users/audit-log', { headers: authHeaders(adminToken) });
  assert.ok(audit.body.entries.some((entry) => entry.action === 'invite-created'));

  const changePassword = await login('registered.staff@example.test', 'Registered123!');
  assert.equal((await jsonRequest('/auth/change-password', 'POST', changePassword, {
    currentPassword: 'wrong', newPassword: 'Changed123!',
  })).response.status, 401);
  assert.equal((await jsonRequest('/auth/change-password', 'POST', changePassword, {
    currentPassword: 'Registered123!', newPassword: 'short',
  })).response.status, 400);
  assert.equal((await jsonRequest('/auth/change-password', 'POST', changePassword, {
    currentPassword: 'Registered123!', newPassword: 'Changed123!',
  })).response.status, 200);
  assert.equal((await request('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'registered.staff@example.test', password: 'Registered123!' }),
  })).response.status, 401);
  assert.ok((await loginSession('registered.staff@example.test', 'Changed123!', { cache: false })).accessToken);

  const forgotForKnownUser = await jsonRequest('/auth/forgot-password', 'POST', undefined, {
    email: 'employee@demo.local', phone: '+15555550125',
  });
  assert.equal(forgotForKnownUser.response.status, 200);
  const forgotForUnknownUser = await jsonRequest('/auth/forgot-password', 'POST', undefined, {
    email: 'missing@demo.local', phone: '+15555550125',
  });
  assert.equal(forgotForUnknownUser.response.status, 200);
  assert.deepEqual(forgotForKnownUser.body, forgotForUnknownUser.body);
  const rateLimitedReset = await jsonRequest('/auth/forgot-password', 'POST', undefined, { email: 'bad', phone: 'bad' });
  assert.equal(rateLimitedReset.response.status, 429);
});

test('clock, break, and manual-correction workflows preserve their state transitions', async () => {
  const employeeToken = await login('employee@demo.local', 'Employee123!');
  const managerToken = await login('manager@demo.local', 'Manager123!');

  assert.equal((await jsonRequest('/shifts/clock-out', 'POST', employeeToken, {})).response.status, 409);
  assert.equal((await request('/shifts/break/start', { method: 'POST', headers: authHeaders(employeeToken) })).response.status, 409);
  assert.equal((await request('/shifts/break/end', { method: 'POST', headers: authHeaders(employeeToken) })).response.status, 409);

  const clockIn = await request('/shifts/clock-in', { method: 'POST', headers: authHeaders(employeeToken) });
  assert.equal(clockIn.response.status, 201);
  const timeEntryId = clockIn.body.entry.id;
  assert.equal((await request('/shifts/clock-in', { method: 'POST', headers: authHeaders(employeeToken) })).response.status, 409);

  const breakStart = await request('/shifts/break/start', { method: 'POST', headers: authHeaders(employeeToken) });
  assert.equal(breakStart.response.status, 201);
  assert.equal((await request('/shifts/break/start', { method: 'POST', headers: authHeaders(employeeToken) })).response.status, 409);
  const breaks = await request('/shifts/breaks/mine', { headers: authHeaders(employeeToken) });
  assert.ok(breaks.body.breaks.some((item) => item.id === breakStart.body.id));
  assert.equal((await request('/shifts/break/end', { method: 'POST', headers: authHeaders(employeeToken) })).response.status, 200);
  assert.equal((await request('/shifts/break/end', { method: 'POST', headers: authHeaders(employeeToken) })).response.status, 409);

  const clockOut = await jsonRequest('/shifts/clock-out', 'POST', employeeToken, { note: 'API test, "completed" shift' });
  assert.equal(clockOut.response.status, 200);
  assert.equal(clockOut.body.entry.id, timeEntryId);
  assert.equal(clockOut.body.entry.note, 'API test, "completed" shift');
  assert.equal((await jsonRequest('/shifts/clock-out', 'POST', employeeToken, { note: 'again' })).response.status, 409);

  const mine = await request('/shifts/mine', { headers: authHeaders(employeeToken) });
  assert.equal(mine.body.currentlyClockedIn, false);
  assert.ok(mine.body.entries.some((entry) => entry.id === timeEntryId && entry.clock_out));
  const mineWeekly = await request('/shifts/summary/mine-weekly', { headers: authHeaders(employeeToken) });
  assert.equal(typeof mineWeekly.body.hours, 'number');
  assert.equal(typeof mineWeekly.body.breakMinutes, 'number');

  const invalidRequest = await jsonRequest('/shifts/requests', 'POST', employeeToken, {
    clockIn: 'not-a-date', clockOut: '2026-01-01T10:00', reason: 'Invalid range',
  });
  assert.equal(invalidRequest.response.status, 400);
  const invalidOrder = await jsonRequest('/shifts/requests', 'POST', employeeToken, {
    clockIn: '2026-01-01T11:00', clockOut: '2026-01-01T10:00', reason: 'Clock order',
  });
  assert.equal(invalidOrder.response.status, 400);

  const correctionDate = dateOffset(-4);
  const correction = await jsonRequest('/shifts/requests', 'POST', employeeToken, {
    clockIn: `${correctionDate}T09:00`, clockOut: `${correctionDate}T17:00`, reason: 'Forgot to clock in',
  });
  assert.equal(correction.response.status, 201);
  const myRequests = await request('/shifts/requests/mine', { headers: authHeaders(employeeToken) });
  assert.ok(myRequests.body.requests.some((item) => item.id === correction.body.request.id));
  assert.equal((await request('/shifts/requests', { headers: authHeaders(employeeToken) })).response.status, 403);
  const managerRequests = await request('/shifts/requests', { headers: authHeaders(managerToken) });
  assert.ok(managerRequests.body.requests.some((item) => item.id === correction.body.request.id));
  assert.equal((await jsonRequest(`/shifts/requests/${correction.body.request.id}`, 'PATCH', managerToken, { status: 'pending' })).response.status, 400);
  assert.equal((await jsonRequest(`/shifts/requests/${correction.body.request.id}`, 'PATCH', employeeToken, { status: 'approved' })).response.status, 403);
  assert.equal((await jsonRequest(`/shifts/requests/${correction.body.request.id}`, 'PATCH', managerToken, { status: 'approved' })).response.status, 200);
  assert.equal((await jsonRequest(`/shifts/requests/${correction.body.request.id}`, 'PATCH', managerToken, { status: 'rejected' })).response.status, 409);

  const rejectedRequest = await jsonRequest('/shifts/requests', 'POST', employeeToken, {
    clockIn: `${dateOffset(-3)}T10:00`, clockOut: `${dateOffset(-3)}T11:00`, reason: 'Second correction',
  });
  assert.equal(rejectedRequest.response.status, 201);
  assert.equal((await jsonRequest(`/shifts/requests/${rejectedRequest.body.request.id}`, 'PATCH', managerToken, { status: 'rejected' })).response.status, 200);
});

test('schedules, open shifts, availability, and leave enforce permissions and conflicts', async () => {
  const employeeToken = invitedEmployee.accessToken;
  const managerToken = await login('manager@demo.local', 'Manager123!');
  const adminToken = await login('admin@demo.local', 'Admin123!');
  const staffId = invitedEmployee.id;
  const shiftDate = dateOffset(50);
  const scheduleBody = { employeeId: staffId, shiftDate, startTime: '09:00', endTime: '17:00', note: 'Integration schedule' };

  assert.equal((await request('/shifts/schedule', { headers: authHeaders(employeeToken) })).response.status, 403);
  assert.equal((await request('/shifts/schedule/team', { headers: authHeaders(employeeToken) })).response.status, 200);
  assert.equal((await jsonRequest('/shifts/schedule', 'POST', employeeToken, scheduleBody)).response.status, 403);
  assert.equal((await jsonRequest('/shifts/schedule', 'POST', managerToken, { ...scheduleBody, shiftDate: 'invalid' })).response.status, 400);
  assert.equal((await jsonRequest('/shifts/schedule', 'POST', managerToken, { ...scheduleBody, endTime: '08:00' })).response.status, 400);

  const schedule = await jsonRequest('/shifts/schedule', 'POST', managerToken, scheduleBody);
  assert.equal(schedule.response.status, 201);
  assert.equal((await jsonRequest('/shifts/schedule', 'POST', managerToken, scheduleBody)).response.status, 409);
  const mySchedule = await request(`/shifts/schedule/mine?from=${shiftDate}`, { headers: authHeaders(employeeToken) });
  assert.ok(mySchedule.body.schedules.some((item) => item.id === schedule.body.id));
  const managerSchedule = await request('/shifts/schedule', { headers: authHeaders(managerToken) });
  assert.ok(managerSchedule.body.schedules.some((item) => item.id === schedule.body.id));

  const secondSchedule = await jsonRequest('/shifts/schedule', 'POST', managerToken, {
    ...scheduleBody, startTime: '18:00', endTime: '21:00',
  });
  assert.equal(secondSchedule.response.status, 201);
  assert.equal((await jsonRequest(`/shifts/schedule/${secondSchedule.body.id}`, 'PATCH', managerToken, {
    shiftDate, startTime: '10:00', endTime: '12:00',
  })).response.status, 409);
  assert.equal((await jsonRequest(`/shifts/schedule/${secondSchedule.body.id}`, 'PATCH', managerToken, {
    shiftDate, startTime: '19:00', endTime: '22:00',
  })).response.status, 200);
  assert.equal((await jsonRequest(`/shifts/schedule/${schedule.body.id}`, 'PATCH', invitedManager.accessToken, {
    shiftDate, startTime: '09:00', endTime: '16:00',
  })).response.status, 403);
  assert.equal((await request(`/shifts/schedule/${schedule.body.id}`, { method: 'DELETE', headers: authHeaders(invitedManager.accessToken) })).response.status, 404);
  assert.equal((await request(`/shifts/schedule/${secondSchedule.body.id}`, { method: 'DELETE', headers: authHeaders(managerToken) })).response.status, 200);
  assert.equal((await request(`/shifts/schedule/${secondSchedule.body.id}`, { method: 'DELETE', headers: authHeaders(managerToken) })).response.status, 404);
  assert.equal((await jsonRequest(`/shifts/schedule/${schedule.body.id}`, 'PATCH', adminToken, {
    shiftDate, startTime: '08:00', endTime: '16:00',
  })).response.status, 200);

  const openShift = await jsonRequest('/shifts/open-shifts', 'POST', managerToken, {
    shiftDate: dateOffset(55), startTime: '08:00', endTime: '12:00',
  });
  assert.equal(openShift.response.status, 201);
  assert.equal((await jsonRequest('/shifts/open-shifts', 'POST', employeeToken, {
    shiftDate: dateOffset(56), startTime: '08:00', endTime: '12:00',
  })).response.status, 403);
  assert.equal((await jsonRequest('/shifts/open-shifts', 'POST', managerToken, {
    shiftDate: dateOffset(56), startTime: '12:00', endTime: '08:00',
  })).response.status, 400);
  const openList = await request('/shifts/open-shifts', { headers: authHeaders(employeeToken) });
  assert.ok(openList.body.openShifts.some((item) => item.id === openShift.body.id));
  assert.equal((await request(`/shifts/open-shifts/999999/claim`, { method: 'POST', headers: authHeaders(employeeToken) })).response.status, 409);

  const unavailableDate = dateOffset(70);
  const unavailable = await jsonRequest('/shifts/unavailable-dates/mine', 'POST', employeeToken, {
    date: unavailableDate, note: 'Personal commitment',
  });
  assert.equal(unavailable.response.status, 201);
  assert.equal((await jsonRequest('/shifts/unavailable-dates/mine', 'POST', employeeToken, { date: unavailableDate })).response.status, 409);
  assert.equal((await jsonRequest('/shifts/unavailable-dates/mine', 'POST', employeeToken, { date: 'not-a-date' })).response.status, 400);
  const unavailableList = await request('/shifts/unavailable-dates/mine', { headers: authHeaders(employeeToken) });
  assert.ok(unavailableList.body.dates.some((item) => item.id === unavailable.body.id));
  assert.equal((await request(`/shifts/unavailable-dates/mine/${unavailable.body.id}`, { method: 'DELETE', headers: authHeaders(managerToken) })).response.status, 404);
  assert.equal((await request(`/shifts/unavailable-dates/mine/${unavailable.body.id}`, { method: 'DELETE', headers: authHeaders(employeeToken) })).response.status, 200);
  assert.equal((await request(`/shifts/unavailable-dates/mine/${unavailable.body.id}`, { method: 'DELETE', headers: authHeaders(employeeToken) })).response.status, 404);

  const leaveStart = dateOffset(80);
  const leaveEnd = dateOffset(82);
  assert.equal((await jsonRequest('/shifts/sick-leave', 'POST', employeeToken, { startDate: leaveStart, endDate: dateOffset(79) })).response.status, 400);
  const leave = await jsonRequest('/shifts/sick-leave', 'POST', employeeToken, { startDate: leaveStart, endDate: leaveEnd, note: 'Annual leave test' });
  assert.equal(leave.response.status, 201);
  assert.equal(leave.body.status, 'pending');
  const mineLeave = await request('/shifts/sick-leave/mine', { headers: authHeaders(employeeToken) });
  assert.ok(mineLeave.body.requests.some((item) => item.id === leave.body.id));
  assert.equal((await request('/shifts/sick-leave', { headers: authHeaders(employeeToken) })).response.status, 403);
  assert.equal((await jsonRequest(`/shifts/sick-leave/${leave.body.id}`, 'PATCH', managerToken, { status: 'pending' })).response.status, 400);
  assert.equal((await jsonRequest(`/shifts/sick-leave/${leave.body.id}`, 'PATCH', employeeToken, { status: 'approved' })).response.status, 403);
  assert.equal((await jsonRequest(`/shifts/sick-leave/${leave.body.id}`, 'PATCH', managerToken, { status: 'approved' })).response.status, 200);
  assert.equal((await jsonRequest(`/shifts/sick-leave/${leave.body.id}`, 'PATCH', managerToken, { status: 'rejected' })).response.status, 409);
  const balance = await request('/shifts/sick-leave/balance/mine', { headers: authHeaders(employeeToken) });
  assert.equal(balance.body.usedDays, 3);
  assert.equal(balance.body.remainingDays, 22);

  const rejectedLeave = await jsonRequest('/shifts/sick-leave', 'POST', employeeToken, {
    startDate: dateOffset(90), endDate: dateOffset(90),
  });
  assert.equal(rejectedLeave.response.status, 201);
  assert.equal((await jsonRequest(`/shifts/sick-leave/${rejectedLeave.body.id}`, 'PATCH', managerToken, { status: 'rejected' })).response.status, 200);
});

test('feedback, targets, team dashboard, reports, summaries, and exports expose expected data', async () => {
  const employeeToken = await login('employee@demo.local', 'Employee123!');
  const managerToken = await login('manager@demo.local', 'Manager123!');
  const adminToken = await login('admin@demo.local', 'Admin123!');
  const employeeId = fixtureDb.prepare('SELECT id FROM users WHERE email = ?').get('employee@demo.local').id;

  const employeeEntries = await request('/shifts/mine', { headers: authHeaders(employeeToken) });
  const completedEntry = employeeEntries.body.entries.find((entry) => entry.clock_out);
  assert.ok(completedEntry);
  assert.equal((await jsonRequest('/shifts/feedback', 'POST', employeeToken, { timeEntryId: completedEntry.id, rating: 0 })).response.status, 400);
  assert.equal((await jsonRequest('/shifts/feedback', 'POST', employeeToken, { timeEntryId: 999999, rating: 5 })).response.status, 404);
  assert.equal((await jsonRequest('/shifts/feedback', 'POST', employeeToken, { timeEntryId: completedEntry.id, rating: 4, comment: 'Good shift' })).response.status, 200);
  assert.equal((await jsonRequest('/shifts/feedback', 'POST', employeeToken, { timeEntryId: completedEntry.id, rating: 5, comment: 'Updated rating' })).response.status, 200);
  const myFeedback = await request('/shifts/feedback/mine', { headers: authHeaders(employeeToken) });
  assert.equal(myFeedback.body.feedback.find((item) => item.time_entry_id === completedEntry.id).rating, 5);
  assert.equal((await request('/shifts/feedback', { headers: authHeaders(employeeToken) })).response.status, 403);
  const teamFeedback = await request('/shifts/feedback', { headers: authHeaders(managerToken) });
  assert.ok(teamFeedback.body.feedback.some((item) => item.time_entry_id === completedEntry.id));

  assert.equal((await request('/shifts/targets', { headers: authHeaders(employeeToken) })).response.status, 403);
  const targets = await request('/shifts/targets', { headers: authHeaders(managerToken) });
  assert.ok(targets.body.targets.some((item) => item.id === employeeId && item.target_hours === 40));
  assert.equal((await jsonRequest(`/shifts/targets/${employeeId}`, 'PUT', managerToken, { targetHours: 169 })).response.status, 400);
  assert.equal((await jsonRequest(`/shifts/targets/${employeeId}`, 'PUT', employeeToken, { targetHours: 37.5 })).response.status, 403);
  assert.equal((await jsonRequest(`/shifts/targets/${employeeId}`, 'PUT', managerToken, { targetHours: 37.5 })).response.status, 200);
  const updatedTargets = await request('/shifts/targets', { headers: authHeaders(adminToken) });
  assert.equal(updatedTargets.body.targets.find((item) => item.id === employeeId).target_hours, 37.5);

  assert.equal((await request('/shifts/team', { headers: authHeaders(employeeToken) })).response.status, 403);
  const team = await request('/shifts/team', { headers: authHeaders(managerToken) });
  assert.ok(team.body.entries.some((entry) => entry.id === completedEntry.id));
  const dashboard = await request('/shifts/dashboard', { headers: authHeaders(managerToken) });
  assert.ok(Array.isArray(dashboard.body.todayStaff));
  assert.ok(Array.isArray(dashboard.body.clockedIn));
  assert.equal(typeof dashboard.body.pendingApprovals.total, 'number');

  const weekly = await request('/shifts/summary/weekly?offset=not-a-number', { headers: authHeaders(managerToken) });
  assert.ok(weekly.body.weekStart);
  assert.ok(weekly.body.weekEnd);
  assert.ok(weekly.body.summary.some((item) => item.userId === employeeId && item.targetHours === 37.5));
  assert.equal((await request('/shifts/summary/weekly', { headers: authHeaders(employeeToken) })).response.status, 403);
  const reportDate = new Date().toISOString().slice(0, 10);
  const reports = await request(`/shifts/reports?from=${reportDate}&to=${reportDate}`, { headers: authHeaders(managerToken) });
  assert.equal(reports.body.from, reportDate);
  assert.ok(reports.body.hoursByEmployee.some((item) => item.userId === employeeId));
  assert.ok(Array.isArray(reports.body.attendance));
  assert.ok(Array.isArray(reports.body.leave));
  assert.ok(Array.isArray(reports.body.feedback));
  assert.equal((await request('/shifts/reports', { headers: authHeaders(employeeToken) })).response.status, 403);

  const exportResponse = await fetch(`${baseUrl}/shifts/export?from=${reportDate}&to=${reportDate}`, {
    headers: authHeaders(managerToken),
  });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-type'), /text\/csv/);
  const csv = await exportResponse.text();
  assert.ok(csv.startsWith('"Staff","Business ID","Department"'));
  assert.ok(csv.includes('"API test, ""completed"" shift"'));
  assert.equal((await request('/shifts/export', { headers: authHeaders(employeeToken) })).response.status, 403);
});

test('account lockout and per-IP login throttling activate at their configured limits', async () => {
  const lockedEmail = 'invited.manager@example.test';
  const lockedPassword = 'ManagerInvited123!';
  let auxiliary = await startAuxServer();
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await requestAt(auxiliary.baseUrl, '/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: lockedEmail, password: 'WrongPassword123!' }),
      });
      assert.equal(result.response.status, attempt === 5 ? 423 : 401);
    }
    const lockedLogin = await requestAt(auxiliary.baseUrl, '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: lockedEmail, password: lockedPassword }),
    });
    assert.equal(lockedLogin.response.status, 423);
  } finally {
    await auxiliary.stop();
  }

  auxiliary = await startAuxServer();
  try {
    for (let attempt = 1; attempt <= 21; attempt += 1) {
      const result = await requestAt(auxiliary.baseUrl, '/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'unknown@example.test', password: 'WrongPassword123!' }),
      });
      assert.equal(result.response.status, attempt === 21 ? 429 : 401);
    }
  } finally {
    await auxiliary.stop();
  }
});
