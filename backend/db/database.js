const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcrypt');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'shifts.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Schema ----------

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business_id TEXT,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('employee','manager','admin')) DEFAULT 'employee',
  department TEXT DEFAULT 'Housekeeping',
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TEXT NOT NULL,
  clock_out TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shift_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TEXT NOT NULL,
  clock_out TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id INTEGER NOT NULL REFERENCES users(id),
  shift_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sick_leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shift_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  time_entry_id INTEGER NOT NULL UNIQUE REFERENCES time_entries(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wellbeing_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK(category IN ('workload','ergonomics','incident','other')),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','acknowledged','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_time_entries_user ON time_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_shift_requests_status ON shift_requests(status);
CREATE INDEX IF NOT EXISTS idx_schedules_employee_date ON schedules(employee_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_sick_leave_status ON sick_leave_requests(status);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON shift_feedback(created_at);
`);

const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
if (!userColumns.includes('business_id')) {
  db.exec('ALTER TABLE users ADD COLUMN business_id TEXT');
}
if (!userColumns.includes('phone')) {
  db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
}

// ---------- Seed demo data (only if empty) ----------

const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;

if (userCount === 0) {
  const insert = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, department)
    VALUES (?, ?, ?, ?, ?)
  `);

  const demoUsers = [
    ['Admin User', 'admin@demo.local', 'Admin123!', 'admin', 'Management'],
    ['Maria Manager', 'manager@demo.local', 'Manager123!', 'manager', 'Housekeeping'],
    ['Elina Employee', 'employee@demo.local', 'Employee123!', 'employee', 'Housekeeping'],
  ];

  const insertMany = db.transaction((rows) => {
    for (const [name, email, plainPw, role, dept] of rows) {
      const hash = bcrypt.hashSync(plainPw, 12);
      insert.run(name, email, hash, role, dept);
    }
  });

  insertMany(demoUsers);
  console.log('Seeded demo users: admin@demo.local / manager@demo.local / employee@demo.local (see README for passwords)');
}

module.exports = db;
