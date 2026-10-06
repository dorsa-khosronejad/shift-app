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

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function backup({
  dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'shifts.db'),
  backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'),
  retentionDays = parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || 30,
} = {}) {
  if (!fs.existsSync(dbPath)) throw new Error(`No database found at ${dbPath} — nothing to back up.`);

  fs.mkdirSync(backupDir, { recursive: true });

  const destPath = path.join(backupDir, `shifts-${timestamp()}.db`);
  const source = new Database(dbPath, { readonly: true });

  // .backup() is SQLite's official online-backup mechanism: it's safe to run
  // against a live, in-use database and produces a consistent snapshot.
  try {
    await source.backup(destPath);
    console.log(`Backup written: ${destPath}`);
    pruneOldBackups(backupDir, retentionDays);
    return destPath;
  } finally {
    source.close();
  }
}

function pruneOldBackups(backupDir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('shifts-') && f.endsWith('.db'));

  let removed = 0;
  for (const file of files) {
    const fullPath = path.join(backupDir, file);
    if (fs.statSync(fullPath).mtimeMs < cutoff) {
      fs.unlinkSync(fullPath);
      removed += 1;
    }
  }
  if (removed > 0) console.log(`Pruned ${removed} backup(s) older than ${retentionDays} days.`);
}

if (require.main === module) {
  backup().catch((error) => {
    console.error('Backup failed:', error);
    process.exitCode = 1;
  });
}

module.exports = { backup, pruneOldBackups };
