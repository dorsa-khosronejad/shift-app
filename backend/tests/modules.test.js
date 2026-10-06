const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const Database = require('better-sqlite3');

let tempDir;
let db;
let tokens;
let security;
let notifications;
let authMiddleware;
let backupScript;
let restoreScript;

before(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shift-modules-'));
  process.env.DB_PATH = path.join(tempDir, 'fixture.db');
  process.env.JWT_ACCESS_SECRET = 'module-test-access-secret-12345678901234567890';
  process.env.JWT_REFRESH_SECRET = 'module-test-refresh-secret-12345678901234567890';
  process.env.SMTP_HOST = '';
  process.env.SMTP_FROM = '';

  db = require('../db/database');
  tokens = require('../utils/tokens');
  security = require('../utils/security');
  notifications = require('../utils/notifications');
  authMiddleware = require('../middleware/auth');
  backupScript = require('../scripts/backup');
  restoreScript = require('../scripts/restore');
});

after(async () => {
  db?.close();
  await fs.rm(tempDir, { recursive: true, force: true });
});

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('access and refresh token utilities sign claims, expire, and hash opaque secrets', () => {
  const user = { id: 42, role: 'manager', name: 'Morgan Manager' };
  const accessToken = tokens.signAccessToken(user);
  const claims = tokens.verifyAccessToken(accessToken);
  assert.equal(claims.sub, user.id);
  assert.equal(claims.role, user.role);
  assert.equal(claims.name, user.name);
  assert.throws(() => tokens.verifyAccessToken('not-a-jwt'));

  const jwt = require('jsonwebtoken');
  const expiredToken = jwt.sign({ sub: user.id }, process.env.JWT_ACCESS_SECRET, { expiresIn: -1 });
  assert.throws(() => tokens.verifyAccessToken(expiredToken), { name: 'TokenExpiredError' });

  const refresh = tokens.generateRefreshToken();
  assert.match(refresh.raw, /^[a-f0-9]{96}$/);
  assert.equal(refresh.hash.length, 64);
  assert.equal(refresh.hash, tokens.hashRefreshToken(refresh.raw));
  assert.notEqual(refresh.raw, refresh.hash);
  assert.ok(Math.abs(Date.parse(refresh.expiresAt) - Date.now() - tokens.REFRESH_TOKEN_TTL_MS) < 5000);
});

test('TOTP utilities generate Base32 secrets and verify the current time window', () => {
  const secret = security.createTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);
  const code = security.totpCode(secret);
  assert.match(code, /^\d{6}$/);
  assert.equal(security.verifyTotp(secret, code), true);
  assert.equal(security.verifyTotp(secret, '12x456'), false);
  assert.equal(security.verifyTotp('', code), false);
  assert.throws(() => security.totpCode('INVALID0'), /Invalid base32 secret/);
});

test('login and audit helpers persist normalized metadata and JSON details', () => {
  const userId = db.prepare("SELECT id FROM users WHERE email = 'employee@demo.local'").get().id;
  const request = { ip: '192.0.2.10', get: (header) => header === 'user-agent' ? 'module-test-agent' : null };
  security.recordLogin({
    userId,
    email: 'employee@demo.local',
    success: false,
    method: 'password',
    request,
    failureReason: 'test-failure',
  });
  const login = db.prepare('SELECT * FROM login_history WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  assert.equal(login.success, 0);
  assert.equal(login.ip_address, '192.0.2.10');
  assert.equal(login.user_agent, 'module-test-agent');
  assert.equal(login.failure_reason, 'test-failure');

  security.recordAudit({
    actorUserId: userId,
    action: 'module-test',
    targetUserId: userId,
    details: { source: 'unit-test', count: 2 },
    request,
  });
  const audit = db.prepare('SELECT * FROM audit_log WHERE action = ?').get('module-test');
  assert.equal(audit.actor_user_id, userId);
  assert.equal(audit.target_user_id, userId);
  assert.deepEqual(JSON.parse(audit.details), { source: 'unit-test', count: 2 });
  assert.equal(audit.ip_address, '192.0.2.10');
});

test('auth middleware distinguishes missing, malformed, expired, and role-denied requests', () => {
  let nextCalls = 0;
  const next = () => { nextCalls += 1; };

  const missingResponse = mockResponse();
  authMiddleware.requireAuth({ headers: {} }, missingResponse, next);
  assert.equal(missingResponse.statusCode, 401);
  assert.match(missingResponse.body.error, /Authorization/);

  const invalidResponse = mockResponse();
  authMiddleware.requireAuth({ headers: { authorization: 'Bearer invalid-token' } }, invalidResponse, next);
  assert.equal(invalidResponse.statusCode, 401);
  assert.equal(invalidResponse.body.error, 'Invalid access token');

  const jwt = require('jsonwebtoken');
  const expiredToken = jwt.sign({ sub: 1 }, process.env.JWT_ACCESS_SECRET, { expiresIn: -1 });
  const expiredResponse = mockResponse();
  authMiddleware.requireAuth({ headers: { authorization: `Bearer ${expiredToken}` } }, expiredResponse, next);
  assert.equal(expiredResponse.statusCode, 401);
  assert.equal(expiredResponse.body.code, 'TOKEN_EXPIRED');

  const accessToken = tokens.signAccessToken({ id: 7, role: 'employee', name: 'Elina Employee' });
  const request = { headers: { authorization: `Bearer ${accessToken}` } };
  authMiddleware.requireAuth(request, mockResponse(), next);
  assert.deepEqual(request.user, { id: 7, role: 'employee', name: 'Elina Employee' });
  assert.equal(nextCalls, 1);

  const unauthenticatedRoleResponse = mockResponse();
  authMiddleware.requireRole('manager')( {}, unauthenticatedRoleResponse, next);
  assert.equal(unauthenticatedRoleResponse.statusCode, 401);

  const forbiddenResponse = mockResponse();
  authMiddleware.requireRole('manager')({ user: { role: 'employee' } }, forbiddenResponse, next);
  assert.equal(forbiddenResponse.statusCode, 403);

  const allowedResponse = mockResponse();
  authMiddleware.requireRole('manager', 'admin')({ user: { role: 'admin' } }, allowedResponse, next);
  assert.equal(nextCalls, 2);
});

test('notification helper persists unread rows and reports unavailable email transport', () => {
  const userId = db.prepare("SELECT id FROM users WHERE email = 'employee@demo.local'").get().id;
  assert.equal(notifications.sendEmail({ to: 'employee@demo.local', subject: 'Test', text: 'Test' }), false);
  assert.equal(notifications.sendEmail({ to: null, subject: 'Test', text: 'Test' }), false);

  notifications.notifyUser(userId, {
    type: 'module-test',
    title: 'Module test notification',
    message: 'Notification persistence check',
  });
  const row = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND type = ? ORDER BY id DESC LIMIT 1').get(userId, 'module-test');
  assert.equal(row.title, 'Module test notification');
  assert.equal(row.message, 'Notification persistence check');
  assert.equal(row.read_at, null);
});

test('SQLite backup creates a consistent snapshot and prunes only expired backup files', async () => {
  const backupDir = path.join(tempDir, 'backups');
  await fs.mkdir(backupDir, { recursive: true });
  const expiredBackup = path.join(backupDir, 'shifts-expired.db');
  const unrelatedFile = path.join(backupDir, 'notes.txt');
  await fs.writeFile(expiredBackup, 'old-backup');
  await fs.writeFile(unrelatedFile, 'keep');
  await fs.utimes(expiredBackup, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));

  const backupPath = await backupScript.backup({
    dbPath: process.env.DB_PATH,
    backupDir,
    retentionDays: 30,
  });
  assert.equal(path.dirname(backupPath), backupDir);
  assert.match(path.basename(backupPath), /^shifts-.*\.db$/);
  assert.equal(await fs.stat(expiredBackup).then(() => true, () => false), false);
  assert.equal(await fs.readFile(unrelatedFile, 'utf8'), 'keep');

  const snapshot = new Database(backupPath, { readonly: true });
  assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM users').get().count, 3);
  snapshot.close();

  await assert.rejects(
    backupScript.backup({ dbPath: path.join(tempDir, 'missing.db'), backupDir }),
    /No database found/
  );
});

test('restore preserves the previous database and removes stale SQLite sidecars', async () => {
  const backupPath = path.join(tempDir, 'restore-source.db');
  const source = new Database(backupPath);
  source.exec('CREATE TABLE restore_check (value TEXT); INSERT INTO restore_check VALUES (\'restored\');');
  source.close();

  const targetPath = path.join(tempDir, 'restore-target', 'shifts.db');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const target = new Database(targetPath);
  target.exec('CREATE TABLE restore_check (value TEXT); INSERT INTO restore_check VALUES (\'previous\');');
  target.close();
  await fs.writeFile(`${targetPath}-wal`, 'stale-wal');
  await fs.writeFile(`${targetPath}-shm`, 'stale-shm');

  const result = restoreScript.restore({ backupFile: backupPath, dbPath: targetPath });
  assert.equal(result.dbPath, targetPath);
  assert.ok(result.safetyCopy);
  assert.equal(await fs.readFile(result.safetyCopy).then(() => true, () => false), true);
  assert.equal(await fs.readFile(`${targetPath}-wal`).then(() => true, () => false), false);
  assert.equal(await fs.readFile(`${targetPath}-shm`).then(() => true, () => false), false);

  const restored = new Database(targetPath, { readonly: true });
  assert.equal(restored.prepare('SELECT value FROM restore_check').get().value, 'restored');
  restored.close();
  const safety = new Database(result.safetyCopy, { readonly: true });
  assert.equal(safety.prepare('SELECT value FROM restore_check').get().value, 'previous');
  safety.close();

  assert.throws(() => restoreScript.restore({ backupFile: path.join(tempDir, 'missing.db'), dbPath: targetPath }), /Backup file not found/);
});