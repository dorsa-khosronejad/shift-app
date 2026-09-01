// Creates a timestamped, consistent copy of the database — safe to run even
// while the server is live, because it uses SQLite's own backup API rather
// than just copying the file (which could grab it mid-write and corrupt it).
//
// Usage:
//   node scripts/backup.js
//
// Typically run on a schedule (see README "Backups" section for cron/systemd
// timer examples). Old backups beyond BACKUP_RETENTION_DAYS are pruned
// automatically so this doesn't fill up the disk forever.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'shifts.db');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || 30;

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backup() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database found at ${DB_PATH} — nothing to back up.`);
    process.exit(1);
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const destPath = path.join(BACKUP_DIR, `shifts-${timestamp()}.db`);
  const source = new Database(DB_PATH, { readonly: true });

  // .backup() is SQLite's official online-backup mechanism: it's safe to run
  // against a live, in-use database and produces a consistent snapshot.
  source.backup(destPath)
    .then(() => {
      source.close();
      console.log(`Backup written: ${destPath}`);
      pruneOldBackups();
    })
    .catch((err) => {
      source.close();
      console.error('Backup failed:', err);
      process.exit(1);
    });
}

function pruneOldBackups() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('shifts-') && f.endsWith('.db'));

  let removed = 0;
  for (const file of files) {
    const fullPath = path.join(BACKUP_DIR, file);
    if (fs.statSync(fullPath).mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
      removed += 1;
    }
  }
  if (removed > 0) console.log(`Pruned ${removed} backup(s) older than ${RETENTION_DAYS} days.`);
}

backup();
