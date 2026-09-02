const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- GET /api/users ----------
// Admin only: list all staff accounts.
router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  const users = db
    .prepare('SELECT id, name, business_id, email, role, department, is_active, created_at FROM users ORDER BY created_at DESC')
    .all();
  res.json({ users });
});

router.get('/staff', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const staff = db.prepare("SELECT id, name, business_id, department FROM users WHERE role = 'employee' AND is_active = 1 ORDER BY name").all();
  res.json({ users: staff });
});

router.get('/notifications', requireAuth, (req, res) => {
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json({ notifications, unreadCount: notifications.filter((notification) => !notification.read_at).length });
});

router.patch('/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ message: 'Notification marked as read' });
});

// ---------- PATCH /api/users/:id/status ----------
// Admin only: deactivate/reactivate an account (e.g. staff member left).
router.patch(
  '/:id/status',
  requireAuth,
  requireRole('admin'),
  [body('is_active').isBoolean()],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'is_active must be true or false' });
    }

    if (Number(req.params.id) === req.user.id) {
      return res.status(400).json({ error: "You can't deactivate your own account" });
    }

    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(
      req.body.is_active ? 1 : 0,
      req.params.id
    );
    res.json({ message: 'Updated' });
  }
);

// ---------- PATCH /api/users/:id/role ----------
// Only admins can grant manager/admin access.
router.patch(
  '/:id/role',
  requireAuth,
  requireRole('admin'),
  [body('role').isIn(['employee', 'manager', 'admin'])],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid role' });
    if (Number(req.params.id) === req.user.id && req.body.role !== 'admin') {
      return res.status(400).json({ error: "You can't remove your own admin role" });
    }
    const result = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Account not found' });
    res.json({ message: 'Role updated' });
  }
);

// ---------- Wellbeing reports (scoped, non-medical) ----------
// Deliberately narrow: workload / ergonomics / incident flags only.
// No symptom or diagnosis fields — that would be special-category health
// data under GDPR and needs a much stricter legal basis than this MVP has.

router.post(
  '/wellbeing-reports',
  requireAuth,
  [
    body('category').isIn(['workload', 'ergonomics', 'incident', 'other']),
    body('description').trim().isLength({ min: 5, max: 1000 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Please choose a category and describe the issue (5+ characters)' });
    }

    const result = db
      .prepare('INSERT INTO wellbeing_reports (user_id, category, description) VALUES (?, ?, ?)')
      .run(req.user.id, req.body.category, req.body.description);

    res.status(201).json({ id: result.lastInsertRowid });
  }
);

router.get('/wellbeing-reports/mine', requireAuth, (req, res) => {
  const reports = db
    .prepare('SELECT * FROM wellbeing_reports WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ reports });
});

router.get(
  '/wellbeing-reports',
  requireAuth,
  requireRole('manager', 'admin'),
  (req, res) => {
    const reports = db
      .prepare(
        `SELECT wr.*, u.name AS user_name, u.department
         FROM wellbeing_reports wr
         JOIN users u ON u.id = wr.user_id
         ORDER BY wr.created_at DESC`
      )
      .all();
    res.json({ reports });
  }
);

router.patch(
  '/wellbeing-reports/:id/status',
  requireAuth,
  requireRole('manager', 'admin'),
  [body('status').isIn(['open', 'acknowledged', 'resolved'])],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    db.prepare('UPDATE wellbeing_reports SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
    res.json({ message: 'Updated' });
  }
);

module.exports = router;
