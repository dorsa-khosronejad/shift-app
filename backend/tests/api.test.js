const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, before, test } = require('node:test');

let tempDir;
let server;
const port = 4200 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}/api`;

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function login(email, password) {
  const result = await request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(result.response.status, 200);
  return result.body.accessToken;
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

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-api-'));
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: path.join(tempDir, 'shifts.db'),
      CORS_ORIGIN: 'http://localhost:5500',
      JWT_ACCESS_SECRET: 'test-access-secret-1234567890abcdefghijklmnopqrstuv',
      JWT_REFRESH_SECRET: 'test-refresh-secret-1234567890abcdefghijklmnop',
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  await waitForReady();
});

after(async () => {
  server.kill('SIGTERM');
  await fs.rm(tempDir, { recursive: true, force: true });
});

test('readiness, login, role protection, and schedule conflict handling', async () => {
  const managerToken = await login('manager@demo.local', 'Manager123!');
  const employeeToken = await login('employee@demo.local', 'Employee123!');

  const ready = await request('/ready');
  assert.equal(ready.body.status, 'ready');

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
