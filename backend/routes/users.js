const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- GET /api/users ----------
// Admin only: list all staff accounts.
router.get('/', requireAuth, requireRole('admin'), (req, res) => {
  const users = db
    .prepare('SELECT id, name, email, role, department, is_active, created_at FROM users ORDER BY created_at DESC')
    .all();
  res.json({ users });
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
