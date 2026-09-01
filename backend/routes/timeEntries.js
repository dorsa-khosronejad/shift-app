const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// ---------- Date helpers ----------
// Entries are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings (SQLite datetime('now')).
// These helpers work in that same format so string comparison in SQL stays valid.

function toSqliteUTC(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// Monday 00:00 UTC of the week containing `offsetWeeks` weeks from now.
function getWeekRange(offsetWeeks = 0) {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday + offsetWeeks * 7));
  const nextMonday = new Date(monday);
  nextMonday.setUTCDate(monday.getUTCDate() + 7);
  return { start: toSqliteUTC(monday), end: toSqliteUTC(nextMonday) };
}

function minutesBetween(startIso, endIso) {
  const start = new Date(startIso.replace(' ', 'T') + 'Z');
  const end = new Date(endIso.replace(' ', 'T') + 'Z');
  return Math.max(0, Math.round((end - start) / 60000));
}

// ---------- POST /api/shifts/clock-in ----------
router.post('/clock-in', requireAuth, (req, res) => {
  const openEntry = db
    .prepare('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL')
    .get(req.user.id);

  if (openEntry) {
    return res.status(409).json({ error: 'You are already clocked in', entry: openEntry });
  }

  const result = db
    .prepare("INSERT INTO time_entries (user_id, clock_in) VALUES (?, datetime('now'))")
    .run(req.user.id);

  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ entry });
});

// ---------- POST /api/shifts/clock-out ----------
router.post('/clock-out', requireAuth, [body('note').optional().trim().isLength({ max: 500 })], (req, res) => {
  const openEntry = db
    .prepare('SELECT * FROM time_entries WHERE user_id = ? AND clock_out IS NULL')
    .get(req.user.id);

  if (!openEntry) {
    return res.status(409).json({ error: 'You are not currently clocked in' });
  }

  db.prepare("UPDATE time_entries SET clock_out = datetime('now'), note = ? WHERE id = ?").run(
    req.body.note || null,
    openEntry.id
  );

  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(openEntry.id);
  res.json({ entry });
});

// ---------- GET /api/shifts/mine ----------
router.get('/mine', requireAuth, (req, res) => {
  const entries = db
    .prepare('SELECT * FROM time_entries WHERE user_id = ? ORDER BY clock_in DESC LIMIT 50')
    .all(req.user.id);
  const openEntry = entries.find((e) => !e.clock_out) || null;
  res.json({ entries, currentlyClockedIn: !!openEntry });
});

// ---------- GET /api/shifts/team ----------
// Managers and admins only: see everyone's recent entries.
router.get('/team', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const entries = db
    .prepare(
      `SELECT te.*, u.name AS user_name, u.department
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       ORDER BY te.clock_in DESC
       LIMIT 200`
    )
    .all();
  res.json({ entries });
});

// ---------- GET /api/shifts/summary/weekly ----------
// Managers and admins: total hours per staff member for a given week.
// ?offset=0 is the current week, ?offset=-1 is last week, etc.
router.get('/summary/weekly', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const offset = parseInt(req.query.offset, 10) || 0;
  const { start, end } = getWeekRange(offset);

  const rows = db
    .prepare(
      `SELECT te.user_id, u.name AS user_name, u.department, te.clock_in, te.clock_out
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       WHERE te.clock_in >= ? AND te.clock_in < ?`
    )
    .all(start, end);

  const totals = {};
  for (const row of rows) {
    if (!totals[row.user_id]) {
      totals[row.user_id] = { userId: row.user_id, name: row.user_name, department: row.department, minutes: 0, openShift: false };
    }
    if (row.clock_out) {
      totals[row.user_id].minutes += minutesBetween(row.clock_in, row.clock_out);
    } else {
      totals[row.user_id].openShift = true; // still clocked in — hours will grow
    }
  }

  const summary = Object.values(totals)
    .map((t) => ({ ...t, hours: Math.round((t.minutes / 60) * 100) / 100 }))
    .sort((a, b) => b.minutes - a.minutes);

  res.json({ weekStart: start, weekEnd: end, summary });
});

// ---------- GET /api/shifts/summary/mine-weekly ----------
// Any logged-in user: their own total for the current week.
router.get('/summary/mine-weekly', requireAuth, (req, res) => {
  const { start, end } = getWeekRange(0);
  const rows = db
    .prepare('SELECT clock_in, clock_out FROM time_entries WHERE user_id = ? AND clock_in >= ? AND clock_in < ?')
    .all(req.user.id, start, end);

  let minutes = 0;
  let openShift = false;
  for (const row of rows) {
    if (row.clock_out) minutes += minutesBetween(row.clock_in, row.clock_out);
    else openShift = true;
  }

  res.json({ weekStart: start, weekEnd: end, hours: Math.round((minutes / 60) * 100) / 100, openShift });
});

// ---------- GET /api/shifts/export ----------
// Managers and admins: CSV download for payroll. Optional ?from=&to= as
// 'YYYY-MM-DD'; defaults to the last 30 days.
router.get('/export', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const from = req.query.from ? `${req.query.from} 00:00:00` : toSqliteUTC(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  const to = req.query.to ? `${req.query.to} 23:59:59` : toSqliteUTC(new Date());

  const rows = db
    .prepare(
      `SELECT u.name AS user_name, u.department, te.clock_in, te.clock_out
       FROM time_entries te
       JOIN users u ON u.id = te.user_id
       WHERE te.clock_in >= ? AND te.clock_in <= ?
       ORDER BY u.name, te.clock_in`
    )
    .all(from, to);

  const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;

  const header = ['Staff', 'Department', 'Clock in (UTC)', 'Clock out (UTC)', 'Hours'];
  const lines = [header.map(escapeCsv).join(',')];

  for (const r of rows) {
    const hours = r.clock_out ? (minutesBetween(r.clock_in, r.clock_out) / 60).toFixed(2) : 'in progress';
    lines.push([r.user_name, r.department, r.clock_in, r.clock_out || '', hours].map(escapeCsv).join(','));
  }

  const csv = lines.join('\r\n');
  const filename = `shifts_${req.query.from || 'last30days'}_${req.query.to || 'today'}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

module.exports = router;
