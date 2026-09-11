const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendEmail } = require('../utils/notifications');
const { createTotpSecret, verifyTotp, recordLogin, recordAudit } = require('../utils/security');
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_MS,
} = require('../utils/tokens');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

const isProd = process.env.NODE_ENV === 'production';
const cookieOptions = {
  httpOnly: true,       // JS on the page can never read this cookie (XSS protection)
  secure: isProd,       // only sent over HTTPS in production
  sameSite: isProd ? 'none' : 'strict',
  path: '/api/auth',    // only sent to auth endpoints, not every request
  maxAge: REFRESH_TOKEN_TTL_MS,
};

// Slows down brute-force login attempts at the network level, on top of
// the per-account lockout below.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts from this device. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many reset attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createChallenge(userId) {
  const raw = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM two_factor_challenges WHERE user_id = ? OR expires_at < ?').run(userId, new Date().toISOString());
  db.prepare('INSERT INTO two_factor_challenges (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    userId,
    hashToken(raw),
    new Date(Date.now() + 5 * 60 * 1000).toISOString()
  );
  return raw;
}


// ---------- POST /api/auth/login ----------
router.post(
  '/login',
  loginLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('password').isString().isLength({ min: 1 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Enter a valid email and password' });
    }

    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    // Same generic error whether the email doesn't exist or the password is
    // wrong — never reveal which one it was, that leaks which emails are registered.
    const genericError = { error: 'Incorrect email or password' };

    if (!user || !user.is_active) {
      recordLogin({ email, success: false, request: req, failureReason: 'inactive-or-unknown-account' });
      return res.status(401).json(genericError);
    }

    // Account lockout check
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      recordLogin({ userId: user.id, email, success: false, request: req, failureReason: 'account-locked' });
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({
        error: `Account temporarily locked due to repeated failed logins. Try again in ${minutesLeft} minute(s).`,
      });
    }

    const passwordMatches = bcrypt.compareSync(password, user.password_hash);

    if (!passwordMatches) {
      recordLogin({ userId: user.id, email, success: false, request: req, failureReason: 'invalid-password' });
      const attempts = user.failed_login_attempts + 1;
      let lockedUntil = null;

      if (attempts >= MAX_FAILED_ATTEMPTS) {
        lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
      }

      db.prepare('UPDATE users SET failed_login_attempts = ?, locked_until = ? WHERE id = ?')
        .run(attempts, lockedUntil, user.id);

      if (lockedUntil) {
        return res.status(423).json({
          error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.`,
        });
      }
      return res.status(401).json(genericError);
    }

    if (user.two_factor_enabled) {
      const challenge = req.body.challenge;
      const challengeRow = challenge && db.prepare('SELECT * FROM two_factor_challenges WHERE user_id = ? AND token_hash = ? AND used = 0').get(user.id, hashToken(challenge));
      if (!req.body.otp || !challengeRow || new Date(challengeRow.expires_at) < new Date() || !verifyTotp(user.two_factor_secret, req.body.otp)) {
        const challengeToken = challengeRow ? challenge : createChallenge(user.id);
        recordLogin({ userId: user.id, email, success: false, request: req, failureReason: 'two-factor-required-or-invalid' });
        return res.status(401).json({ error: 'Two-factor authentication is required', code: 'TWO_FACTOR_REQUIRED', challenge: challengeToken });
      }
      db.prepare('UPDATE two_factor_challenges SET used = 1 WHERE id = ?').run(challengeRow.id);
    }

    // Successful login: reset failed-attempt counter, issue tokens
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    recordLogin({ userId: user.id, email, success: true, method: user.two_factor_enabled ? 'password+2fa' : 'password', request: req });
    recordAudit({ actorUserId: user.id, action: 'login-success', request: req });

    const accessToken = signAccessToken(user);
    const { raw, hash, expiresAt } = generateRefreshToken();

    db.prepare(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, hash, expiresAt);

    res.cookie('refreshToken', raw, cookieOptions);
    res.json({
      accessToken,
      user: { id: user.id, name: user.name, businessId: user.business_id, email: user.email, phone: user.phone, role: user.role, department: user.department, twoFactorEnabled: !!user.two_factor_enabled },
    });
  }
);

// ---------- POST /api/auth/refresh ----------
// Called silently by the frontend when the access token expires, using the
// httpOnly refresh cookie the browser sends automatically.
router.post('/refresh', (req, res) => {
  const raw = req.cookies?.refreshToken;
  if (!raw) {
    return res.status(401).json({ error: 'No refresh token provided' });
  }

  const hash = hashRefreshToken(raw);
  const stored = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash);

  if (!stored || stored.revoked || new Date(stored.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Refresh token invalid or expired, please log in again' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Account no longer active' });
  }

  // Rotate the refresh token: revoke the old one, issue a new one.
  // This means a leaked-but-unused refresh token becomes useless the next
  // time the legitimate user refreshes, and reuse of a revoked token could
  // be used as a signal of theft (not implemented here, but the hook exists).
  db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(stored.id);

  const { raw: newRaw, hash: newHash, expiresAt } = generateRefreshToken();
  db.prepare('INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(
    user.id,
    newHash,
    expiresAt
  );

  res.cookie('refreshToken', newRaw, cookieOptions);
  res.json({ accessToken: signAccessToken(user) });
});

// ---------- POST /api/auth/logout ----------
router.post('/logout', (req, res) => {
  const raw = req.cookies?.refreshToken;
  if (raw) {
    const hash = hashRefreshToken(raw);
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(hash);
  }
  res.clearCookie('refreshToken', { path: '/api/auth' });
  res.json({ message: 'Logged out' });
});

// ---------- GET /api/auth/me ----------
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, business_id AS businessId, email, phone, role, department FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
});

router.get('/login-history', requireAuth, (req, res) => {
  const history = db.prepare('SELECT id, success, method, ip_address, user_agent, failure_reason, created_at FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json({ history });
});

router.get('/2fa/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT two_factor_enabled FROM users WHERE id = ?').get(req.user.id);
  res.json({ enabled: !!user.two_factor_enabled });
});

router.post('/2fa/setup', requireAuth, (req, res) => {
  const secret = createTotpSecret();
  db.prepare('UPDATE users SET two_factor_secret = ?, two_factor_enabled = 0 WHERE id = ?').run(secret, req.user.id);
  const user = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  const label = encodeURIComponent(`Shift & Care:${user.email}`);
  res.json({ secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=Shift%20%26%20Care` });
});

router.post('/2fa/enable', requireAuth, [body('code').matches(/^\d{6}$/)], (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Enter the 6-digit authenticator code' });
  const user = db.prepare('SELECT two_factor_secret FROM users WHERE id = ?').get(req.user.id);
  if (!user.two_factor_secret || !verifyTotp(user.two_factor_secret, req.body.code)) return res.status(400).json({ error: 'That authenticator code is invalid' });
  db.prepare('UPDATE users SET two_factor_enabled = 1, email_verified_at = COALESCE(email_verified_at, datetime(\'now\')) WHERE id = ?').run(req.user.id);
  recordAudit({ actorUserId: req.user.id, action: 'two-factor-enabled', request: req });
  res.json({ message: 'Two-factor authentication enabled' });
});

router.post('/2fa/disable', requireAuth, [body('currentPassword').isString().notEmpty(), body('code').matches(/^\d{6}$/)], (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Enter your password and authenticator code' });
  const user = db.prepare('SELECT password_hash, two_factor_secret FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(req.body.currentPassword, user.password_hash) || !verifyTotp(user.two_factor_secret, req.body.code)) return res.status(401).json({ error: 'Password or authenticator code is incorrect' });
  db.prepare('UPDATE users SET two_factor_secret = NULL, two_factor_enabled = 0 WHERE id = ?').run(req.user.id);
  recordAudit({ actorUserId: req.user.id, action: 'two-factor-disabled', request: req });
  res.json({ message: 'Two-factor authentication disabled' });
});

router.post('/verify-email', [body('token').isHexadecimal().isLength({ min: 64, max: 64 })], (req, res) => {
  if (!validationResult(req).isEmpty()) return res.status(400).json({ error: 'Invalid verification link' });
  const token = db.prepare('SELECT * FROM email_verification_tokens WHERE token_hash = ? AND used = 0').get(hashToken(req.body.token));
  if (!token || new Date(token.expires_at) < new Date()) return res.status(401).json({ error: 'This verification link is invalid or expired' });
  db.transaction(() => {
    db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(token.user_id);
    db.prepare('UPDATE email_verification_tokens SET used = 1 WHERE id = ?').run(token.id);
  })();
  recordAudit({ targetUserId: token.user_id, action: 'email-verified', request: req });
  res.json({ message: 'Email verified. You can now sign in.' });
});

// ---------- POST /api/auth/register ----------
// Admin-only: this is a staff tool, not public self-signup. An admin creates
// accounts for real employees. Keeps the roster controlled.
router.post(
  '/register',
  requireAuth,
  requireRole('admin'),
  [
    body('name').trim().isLength({ min: 2 }).withMessage('Name is too short'),
    body('email').isEmail().normalizeEmail(),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/\d/)
      .withMessage('Password must contain a number'),
    body('role').isIn(['employee', 'manager', 'admin']),
    body('department').optional().trim(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { name, email, password, role, department } = req.body;

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const hash = bcrypt.hashSync(password, 12);
    const result = db
      .prepare('INSERT INTO users (name, email, password_hash, role, department) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, hash, role, department || 'Housekeeping');

    res.status(201).json({ id: result.lastInsertRowid, name, email, role });
  }
);

// ---------- POST /api/auth/invites ----------
// Admin-only: generate a one-time signup link for a specific role/department.
// Replaces public self-signup so the roster stays admin-controlled.
router.post(
  '/invites',
  requireAuth,
  requireRole('admin'),
  [
    body('email').isEmail().normalizeEmail(),
    body('role').isIn(['employee', 'manager', 'admin']),
    body('department').optional().trim().isLength({ max: 80 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid email and role' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare(
      'INSERT INTO invites (token_hash, email, role, department, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(hashToken(rawToken), req.body.email, req.body.role, req.body.department?.trim() || 'Housekeeping', req.user.id, expiresAt);

    recordAudit({ actorUserId: req.user.id, action: 'invite-created', details: { email: req.body.email, role: req.body.role }, request: req });

    const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    res.status(201).json({ id: result.lastInsertRowid, link: `${base}/index.html?invite=${rawToken}`, expiresAt });
  }
);

// ---------- GET /api/auth/invites ----------
router.get('/invites', requireAuth, requireRole('admin'), (req, res) => {
  const invites = db.prepare(`
    SELECT i.id, i.email, i.role, i.department, i.expires_at, i.used_at, i.created_at, u.name AS used_by_name
    FROM invites i LEFT JOIN users u ON u.id = i.used_by
    ORDER BY i.created_at DESC LIMIT 100
  `).all();
  res.json({ invites });
});

// ---------- POST /api/auth/invites/accept ----------
// Public: completes an admin-issued invite into an active account.
router.post(
  '/invites/accept',
  [
    body('token').isHexadecimal().isLength({ min: 64, max: 64 }),
    body('firstName').trim().isLength({ min: 2, max: 80 }),
    body('familyName').trim().isLength({ min: 2, max: 80 }),
    body('businessId').trim().isLength({ min: 2, max: 80 }),
    body('phone').trim().isMobilePhone('any'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/\d/)
      .withMessage('Password must contain a number'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter all details and use a password with 8+ characters and a number' });

    const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hashToken(req.body.token));
    if (!invite || invite.used_at || new Date(invite.expires_at) < new Date()) {
      return res.status(401).json({ error: 'This invite link is invalid or expired' });
    }

    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(invite.email);
    const existingBusinessId = db.prepare('SELECT id FROM users WHERE business_id = ?').get(req.body.businessId.trim());
    if (existingEmail || existingBusinessId) return res.status(409).json({ error: 'That email or business ID is already registered' });

    const hash = bcrypt.hashSync(req.body.password, 12);
    const accept = db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO users (name, business_id, email, phone, password_hash, role, department, is_active, email_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`
      ).run(`${req.body.firstName.trim()} ${req.body.familyName.trim()}`, req.body.businessId.trim(), invite.email, req.body.phone.trim(), hash, invite.role, invite.department);
      db.prepare("UPDATE invites SET used_at = datetime('now'), used_by = ? WHERE id = ?").run(result.lastInsertRowid, invite.id);
      return result.lastInsertRowid;
    });
    const newUserId = accept();
    recordAudit({ actorUserId: newUserId, action: 'invite-accepted', targetUserId: newUserId, request: req });

    res.status(201).json({ message: 'Account created. You can now sign in.' });
  }
);

// Self-service reset sends a single-use link; the password is never sent by email.
router.post('/forgot-password', resetLimiter, [
  body('email').isEmail().normalizeEmail(),
  body('phone').trim().isMobilePhone('any'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid work email and phone number' });
  const user = db.prepare('SELECT id FROM users WHERE email = ? AND phone = ?').get(req.body.email, req.body.phone.trim());
  if (!user || !process.env.SMTP_HOST || !process.env.FRONTEND_URL || !process.env.SMTP_FROM) {
    return res.status(user && !process.env.SMTP_HOST ? 503 : 200).json({ message: 'If the details match an account, a reset link will be sent to its email address.' });
  }
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at < ?').run(user.id, new Date().toISOString());
  db.prepare('INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)').run(user.id, tokenHash, expiresAt);
  const resetUrl = `${process.env.FRONTEND_URL.replace(/\/$/, '')}/index.html?reset=${rawToken}`;
  sendEmail({
    to: req.body.email,
    subject: 'Reset your Shift & Care password',
    text: `Use this link within 15 minutes to reset your password: ${resetUrl}\n\nIf you did not request this, ignore this email.`,
  });
  res.json({ message: 'If the details match an account, a reset link will be sent to its email address.' });
});

router.post('/reset-password', resetLimiter, [
  body('token').isHexadecimal().isLength({ min: 64, max: 64 }),
  body('newPassword').isLength({ min: 8 }).matches(/\d/),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Use a password with 8+ characters and a number' });
  const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');
  const token = db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used = 0').get(tokenHash);
  if (!token || new Date(token.expires_at) < new Date()) return res.status(401).json({ error: 'This reset link is invalid or expired' });
  const passwordHash = bcrypt.hashSync(req.body.newPassword, 12);
  const reset = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(passwordHash, token.user_id);
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(token.user_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(token.id);
  });
  reset();
  recordAudit({ targetUserId: token.user_id, action: 'password-reset', request: req });
  res.json({ message: 'Password reset successfully. You can now sign in.' });
});

// ---------- POST /api/auth/change-password ----------
router.post(
  '/change-password',
  requireAuth,
  [
    body('currentPassword').isString().notEmpty(),
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('New password must be at least 8 characters')
      .matches(/\d/)
      .withMessage('New password must contain a number'),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { currentPassword, newPassword } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

    if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = bcrypt.hashSync(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);

    // Revoke all existing refresh tokens so other sessions are logged out
    // after a password change — standard practice if a password may have leaked.
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(user.id);
    recordAudit({ actorUserId: user.id, action: 'password-changed', request: req });

    res.json({ message: 'Password changed. Please log in again.' });
  }
);

module.exports = router;
