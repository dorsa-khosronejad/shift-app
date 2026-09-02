const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
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
      return res.status(401).json(genericError);
    }

    // Account lockout check
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({
        error: `Account temporarily locked due to repeated failed logins. Try again in ${minutesLeft} minute(s).`,
      });
    }

    const passwordMatches = bcrypt.compareSync(password, user.password_hash);

    if (!passwordMatches) {
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

    // Successful login: reset failed-attempt counter, issue tokens
    db.prepare('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);

    const accessToken = signAccessToken(user);
    const { raw, hash, expiresAt } = generateRefreshToken();

    db.prepare(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, hash, expiresAt);

    res.cookie('refreshToken', raw, cookieOptions);
    res.json({
      accessToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, department: user.department },
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
  const user = db.prepare('SELECT id, name, email, role, department FROM users WHERE id = ?').get(req.user.id);
  res.json({ user });
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

// ---------- POST /api/auth/signup ----------
// Public signup creates an inactive employee account for admin approval.
router.post(
  '/signup',
  [
    body('firstName').trim().isLength({ min: 2, max: 80 }),
    body('familyName').trim().isLength({ min: 2, max: 80 }),
    body('businessId').trim().isLength({ min: 2, max: 80 }),
    body('email').isEmail().normalizeEmail(),
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

    const { firstName, familyName, businessId, email, phone, password } = req.body;
    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const existingBusinessId = db.prepare('SELECT id FROM users WHERE business_id = ?').get(businessId.trim());
    if (existingEmail || existingBusinessId) return res.status(409).json({ error: 'That email or business ID is already registered' });

    const hash = bcrypt.hashSync(password, 12);
    const result = db.prepare(
      `INSERT INTO users (name, business_id, email, phone, password_hash, role, department, is_active)
       VALUES (?, ?, ?, ?, ?, 'employee', 'Housekeeping', 0)`
     ).run(`${firstName.trim()} ${familyName.trim()}`, businessId.trim(), email, phone.trim(), hash);

    res.status(201).json({ id: result.lastInsertRowid, message: 'Signup received. An administrator must activate your account before you can sign in.' });
  }
);

// Recovery requests are intentionally generic until an email/SMS provider is configured.
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
  body('phone').trim().isMobilePhone('any'),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Enter a valid work email and phone number' });
  const user = db.prepare('SELECT id FROM users WHERE email = ? AND phone = ?').get(req.body.email, req.body.phone.trim());
  res.json({ message: user ? 'Your request was received. Contact your administrator for a secure password reset.' : 'If those details match an account, recovery instructions will be provided by your administrator.' });
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

    res.json({ message: 'Password changed. Please log in again.' });
  }
);

module.exports = router;
