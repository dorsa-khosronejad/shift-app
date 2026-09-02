const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyUser } = require('../utils/notifications');

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

function parseManualDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : toSqliteUTC(date);
}

function hasScheduleConflict(employeeId, shiftDate, startTime, endTime, excludeId = null) {
  const query = `SELECT id FROM schedules WHERE employee_id = ? AND shift_date = ?
    AND start_time < ? AND end_time > ?${excludeId ? ' AND id != ?' : ''}`;
  const params = excludeId ? [employeeId, shiftDate, endTime, startTime, excludeId] : [employeeId, shiftDate, endTime, startTime];
  return !!db.prepare(query).get(...params);
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
    req.body?.note || null,
    openEntry.id
  );

  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(openEntry.id);
  res.json({ entry });
});

// ---------- POST /api/shifts/requests ----------
// Manual corrections require manager approval before becoming time entries.
router.post('/requests', requireAuth, [
  body('clockIn').custom((value) => !!parseManualDate(value)).withMessage('Enter a valid clock-in time'),
  body('clockOut').custom((value) => !!parseManualDate(value)).withMessage('Enter a valid clock-out time'),
  body('reason').trim().isLength({ min: 3, max: 500 }),
], (req, res) => {
  const errors = validationResult(req);
  const clockIn = parseManualDate(req.body.clockIn);
  const clockOut = parseManualDate(req.body.clockOut);
  if (!errors.isEmpty() || !clockIn || !clockOut || new Date(`${clockOut}Z`) <= new Date(`${clockIn}Z`)) {
    return res.status(400).json({ error: 'Enter a valid time range and reason' });
  }

  const result = db.prepare(
    'INSERT INTO shift_requests (user_id, clock_in, clock_out, reason) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, clockIn, clockOut, req.body.reason.trim());
  const request = db.prepare('SELECT * FROM shift_requests WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ request });
});

// ---------- GET /api/shifts/requests/mine ----------
router.get('/requests/mine', requireAuth, (req, res) => {
  const requests = db.prepare(
    'SELECT * FROM shift_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ requests });
});

// ---------- GET /api/shifts/requests ----------
router.get('/requests', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const requests = db.prepare(
    `SELECT sr.*, u.name AS user_name, u.department
     FROM shift_requests sr JOIN users u ON u.id = sr.user_id
     ORDER BY CASE sr.status WHEN 'pending' THEN 0 ELSE 1 END, sr.created_at DESC
     LIMIT 200`
  ).all();
  res.json({ requests });
});

// ---------- PATCH /api/shifts/requests/:id ----------
router.patch('/requests/:id', requireAuth, requireRole('manager', 'admin'), [
  body('status').isIn(['approved', 'rejected']),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid request status' });

  const request = db.prepare('SELECT * FROM shift_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Shift request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already reviewed' });

  const review = db.transaction(() => {
    db.prepare('UPDATE shift_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
      .run(req.body.status, req.user.id, request.id);
    if (req.body.status === 'approved') {
      db.prepare('INSERT INTO time_entries (user_id, clock_in, clock_out, note) VALUES (?, ?, ?, ?)')
        .run(request.user_id, request.clock_in, request.clock_out, `Manual correction: ${request.reason}`);
    }
  });
  review();
  notifyUser(request.user_id, {
    type: 'manual-correction',
    title: `Manual correction ${req.body.status}`,
    message: `Your manual shift correction for ${request.clock_in} was ${req.body.status}.`,
  });
  res.json({ status: req.body.status });
});

// ---------- Schedules ----------
router.get('/schedule/mine', requireAuth, (req, res) => {
  const schedules = db.prepare(
    'SELECT * FROM schedules WHERE employee_id = ? ORDER BY shift_date, start_time LIMIT 200'
  ).all(req.user.id);
  res.json({ schedules });
});
router.get('/schedule/team', requireAuth, (req, res) => {
  const schedules = db.prepare(
    `SELECT s.id, s.employee_id, s.shift_date, s.start_time, s.end_time,
            u.name AS employee_name, u.department
     FROM schedules s JOIN users u ON u.id = s.employee_id
     ORDER BY s.shift_date, s.start_time, u.name LIMIT 500`
  ).all();
  res.json({ schedules });
});

router.get('/schedule', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const schedules = db.prepare(
    `SELECT s.*, u.name AS employee_name, u.department
     FROM schedules s JOIN users u ON u.id = s.employee_id
     ORDER BY s.shift_date, s.start_time LIMIT 500`
  ).all();
  res.json({ schedules });
});

router.post('/schedule', requireAuth, requireRole('manager', 'admin'), [
  body('employeeId').isInt({ min: 1 }),
  body('shiftDate').isISO8601({ strict: true, strictSeparator: true }),
  body('startTime').matches(/^\d{2}:\d{2}$/),
  body('endTime').matches(/^\d{2}:\d{2}$/),
  body('note').optional().trim().isLength({ max: 300 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty() || req.body.endTime <= req.body.startTime) return res.status(400).json({ error: 'Enter a valid employee and time range' });
  const employee = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'employee' AND is_active = 1").get(req.body.employeeId);
  if (!employee) return res.status(404).json({ error: 'Active employee not found' });
  if (hasScheduleConflict(employee.id, req.body.shiftDate, req.body.startTime, req.body.endTime)) return res.status(409).json({ error: 'This employee already has an overlapping shift' });
  const result = db.prepare(
    'INSERT INTO schedules (employee_id, manager_id, shift_date, start_time, end_time, note) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(employee.id, req.user.id, req.body.shiftDate, req.body.startTime, req.body.endTime, req.body.note?.trim() || null);
  notifyUser(employee.id, {
    type: 'schedule',
    title: 'New shift scheduled',
    message: `You are scheduled on ${req.body.shiftDate} from ${req.body.startTime} to ${req.body.endTime}.`,
  });
  res.status(201).json({ id: result.lastInsertRowid });
});

router.patch('/schedule/:id', requireAuth, requireRole('manager', 'admin'), [
  body('shiftDate').isISO8601({ strict: true, strictSeparator: true }),
  body('startTime').matches(/^\d{2}:\d{2}$/),
  body('endTime').matches(/^\d{2}:\d{2}$/),
], (req, res) => {
  const errors = validationResult(req);
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule entry not found' });
  if (!errors.isEmpty() || req.body.endTime <= req.body.startTime) return res.status(400).json({ error: 'Enter a valid time range' });
  if (hasScheduleConflict(schedule.employee_id, req.body.shiftDate, req.body.startTime, req.body.endTime, schedule.id)) return res.status(409).json({ error: 'This employee already has an overlapping shift' });
  db.prepare('UPDATE schedules SET shift_date = ?, start_time = ?, end_time = ? WHERE id = ?').run(req.body.shiftDate, req.body.startTime, req.body.endTime, schedule.id);
  res.json({ message: 'Schedule updated' });
});

router.get('/open-shifts', requireAuth, (req, res) => {
  const openShifts = db.prepare(
    `SELECT os.*, u.name AS manager_name FROM open_shifts os JOIN users u ON u.id = os.manager_id
     WHERE os.claimed_by IS NULL ORDER BY os.shift_date, os.start_time LIMIT 200`
  ).all();
  res.json({ openShifts });
});

router.post('/open-shifts', requireAuth, requireRole('manager', 'admin'), [
  body('shiftDate').isISO8601({ strict: true, strictSeparator: true }),
  body('startTime').matches(/^\d{2}:\d{2}$/), body('endTime').matches(/^\d{2}:\d{2}$/),
  body('note').optional().trim().isLength({ max: 300 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty() || req.body.endTime <= req.body.startTime) return res.status(400).json({ error: 'Enter a valid open shift time range' });
  const result = db.prepare('INSERT INTO open_shifts (manager_id, shift_date, start_time, end_time, note) VALUES (?, ?, ?, ?, ?)').run(req.user.id, req.body.shiftDate, req.body.startTime, req.body.endTime, req.body.note?.trim() || null);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.post('/open-shifts/:id/claim', requireAuth, requireRole('employee'), (req, res) => {
  const claim = db.transaction(() => {
    const openShift = db.prepare('SELECT * FROM open_shifts WHERE id = ?').get(req.params.id);
    if (!openShift || openShift.claimed_by) return false;
    if (hasScheduleConflict(req.user.id, openShift.shift_date, openShift.start_time, openShift.end_time)) return false;
    db.prepare('UPDATE open_shifts SET claimed_by = ?, claimed_at = datetime(\'now\') WHERE id = ? AND claimed_by IS NULL').run(req.user.id, openShift.id);
    db.prepare('INSERT INTO schedules (employee_id, manager_id, shift_date, start_time, end_time, note) VALUES (?, ?, ?, ?, ?, ?)').run(req.user.id, openShift.manager_id, openShift.shift_date, openShift.start_time, openShift.end_time, openShift.note);
    return true;
  });
  if (!claim()) return res.status(409).json({ error: 'This open shift was claimed or conflicts with your schedule' });
  res.json({ message: 'Open shift claimed' });
});

router.get('/availability/mine', requireAuth, (req, res) => {
  const availability = db.prepare('SELECT weekday, start_time, end_time FROM employee_availability WHERE employee_id = ? ORDER BY weekday').all(req.user.id);
  res.json({ availability });
});

router.put('/availability/mine', requireAuth, [
  body('availability').isArray({ max: 7 }),
], (req, res) => {
  if (!validationResult(req).isEmpty() || req.body.availability.some((item) => !Number.isInteger(item.weekday) || item.weekday < 0 || item.weekday > 6 || !/^\d{2}:\d{2}$/.test(item.startTime) || !/^\d{2}:\d{2}$/.test(item.endTime) || item.endTime <= item.startTime)) return res.status(400).json({ error: 'Enter valid availability windows' });
  const update = db.transaction(() => {
    db.prepare('DELETE FROM employee_availability WHERE employee_id = ?').run(req.user.id);
    const insert = db.prepare('INSERT INTO employee_availability (employee_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)');
    for (const item of req.body.availability) insert.run(req.user.id, item.weekday, item.startTime, item.endTime);
  });
  update();
  res.json({ message: 'Availability saved' });
});

router.delete('/schedule/:id', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Schedule entry not found' });
  res.json({ message: 'Schedule entry removed' });
});

// ---------- Sick leave ----------
router.post('/sick-leave', requireAuth, [
  body('startDate').isISO8601({ strict: true, strictSeparator: true }),
  body('endDate').isISO8601({ strict: true, strictSeparator: true }),
  body('note').optional().trim().isLength({ max: 300 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty() || req.body.endDate < req.body.startDate) return res.status(400).json({ error: 'Enter a valid leave date range' });
  const result = db.prepare('INSERT INTO sick_leave_requests (user_id, start_date, end_date, note) VALUES (?, ?, ?, ?)').run(
    req.user.id, req.body.startDate, req.body.endDate, req.body.note?.trim() || null
  );
  res.status(201).json({ id: result.lastInsertRowid, status: 'pending' });
});

router.get('/sick-leave/mine', requireAuth, (req, res) => {
  const requests = db.prepare('SELECT * FROM sick_leave_requests WHERE user_id = ? ORDER BY start_date DESC LIMIT 100').all(req.user.id);
  res.json({ requests });
});

router.get('/sick-leave', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const requests = db.prepare(
    `SELECT sl.*, u.name AS employee_name, u.department
     FROM sick_leave_requests sl JOIN users u ON u.id = sl.user_id
     ORDER BY CASE sl.status WHEN 'pending' THEN 0 ELSE 1 END, sl.start_date DESC LIMIT 200`
  ).all();
  res.json({ requests });
});

router.patch('/sick-leave/:id', requireAuth, requireRole('manager', 'admin'), [
  body('status').isIn(['approved', 'rejected']),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid leave status' });
  const request = db.prepare('SELECT status FROM sick_leave_requests WHERE id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Leave request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'This request was already reviewed' });
  db.prepare("UPDATE sick_leave_requests SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?").run(req.body.status, req.user.id, req.params.id);
  const reviewedRequest = db.prepare('SELECT user_id, start_date FROM sick_leave_requests WHERE id = ?').get(req.params.id);
  notifyUser(reviewedRequest.user_id, {
    type: 'sick-leave',
    title: `Sick leave ${req.body.status}`,
    message: `Your sick-leave request starting ${reviewedRequest.start_date} was ${req.body.status}.`,
  });
  res.json({ status: req.body.status });
});

// ---------- Shift feedback ----------
router.post('/feedback', requireAuth, [
  body('timeEntryId').isInt({ min: 1 }),
  body('rating').isInt({ min: 1, max: 5 }),
  body('comment').optional().trim().isLength({ max: 500 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Choose a rating from 1 to 5' });
  const entry = db.prepare('SELECT id FROM time_entries WHERE id = ? AND user_id = ? AND clock_out IS NOT NULL').get(req.body.timeEntryId, req.user.id);
  if (!entry) return res.status(404).json({ error: 'Completed shift not found' });
  try {
    const result = db.prepare('INSERT INTO shift_feedback (time_entry_id, user_id, rating, comment) VALUES (?, ?, ?, ?)').run(
      entry.id, req.user.id, req.body.rating, req.body.comment?.trim() || null
    );
    res.status(201).json({ id: result.lastInsertRowid });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Feedback already submitted for this shift' });
    throw error;
  }
});

router.get('/feedback', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const feedback = db.prepare(
    `SELECT sf.*, u.name AS employee_name, u.department, te.clock_in, te.clock_out
     FROM shift_feedback sf JOIN users u ON u.id = sf.user_id JOIN time_entries te ON te.id = sf.time_entry_id
     ORDER BY sf.created_at DESC LIMIT 200`
  ).all();
  res.json({ feedback });
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

// ---------- GET /api/shifts/dashboard ----------
router.get('/dashboard', requireAuth, requireRole('manager', 'admin'), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const upcomingEnd = new Date();
  upcomingEnd.setUTCDate(upcomingEnd.getUTCDate() + 14);
  const endDate = upcomingEnd.toISOString().slice(0, 10);

  const todayStaff = db.prepare(
    `SELECT s.id, s.shift_date, s.start_time, s.end_time, s.note,
            u.id AS employee_id, u.name AS employee_name, u.department,
            CASE WHEN te.id IS NOT NULL THEN 1 ELSE 0 END AS clocked_in
     FROM schedules s
     JOIN users u ON u.id = s.employee_id
     LEFT JOIN time_entries te ON te.user_id = s.employee_id AND te.clock_out IS NULL
     WHERE s.shift_date = ?
     ORDER BY s.start_time, u.name`
  ).all(today);

  const clockedIn = db.prepare(
    `SELECT te.id, te.clock_in, u.name AS employee_name, u.department
     FROM time_entries te JOIN users u ON u.id = te.user_id
     WHERE te.clock_out IS NULL ORDER BY te.clock_in`
  ).all();

  const missingClockOuts = db.prepare(
    `SELECT te.id, te.clock_in, u.name AS employee_name, u.department
     FROM time_entries te JOIN users u ON u.id = te.user_id
     WHERE te.clock_in >= ? AND te.clock_in < ? AND te.clock_out IS NULL
     ORDER BY te.clock_in`
  ).all(`${today} 00:00:00`, `${today} 23:59:59`);

  const upcomingLeave = db.prepare(
    `SELECT sl.id, sl.start_date, sl.end_date, u.name AS employee_name, u.department
     FROM sick_leave_requests sl JOIN users u ON u.id = sl.user_id
     WHERE sl.status = 'approved' AND sl.end_date >= ? AND sl.start_date <= ?
     ORDER BY sl.start_date, u.name LIMIT 50`
  ).all(today, endDate);

  const pendingApprovals = db.prepare(
    `SELECT (SELECT COUNT(*) FROM shift_requests WHERE status = 'pending') AS corrections,
            (SELECT COUNT(*) FROM sick_leave_requests WHERE status = 'pending') AS leave`
  ).get();

  res.json({
    today,
    todayStaff,
    clockedIn,
    missingClockOuts,
    upcomingLeave,
    pendingApprovals: { ...pendingApprovals, total: pendingApprovals.corrections + pendingApprovals.leave },
  });
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
