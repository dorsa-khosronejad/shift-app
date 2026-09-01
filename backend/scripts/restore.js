// Restores the database from a backup file. Moves the current (possibly
// broken) database aside rather than deleting it, so a bad restore doesn't
// destroy your only other copy.
//
// Usage:
//   node scripts/restore.js backups/shifts-2026-08-31T10-00-00-000Z.db

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'db', 'shifts.db');
const backupFile = process.argv[2];

if (!backupFile) {
  console.error('Usage: node scripts/restore.js <path-to-backup-file>');
  console.error('Available backups:');
  const backupDir = path.join(__dirname, '..', 'backups');
  if (fs.existsSync(backupDir)) {
    fs.readdirSync(backupDir).forEach((f) => console.error(`  backups/${f}`));
  }
  process.exit(1);
}

if (!fs.existsSync(backupFile)) {
  console.error(`Backup file not found: ${backupFile}`);
  process.exit(1);
}

if (fs.existsSync(DB_PATH)) {
  const safetyCopy = `${DB_PATH}.before-restore-${Date.now()}`;
  fs.copyFileSync(DB_PATH, safetyCopy);
  console.log(`Current database backed up to: ${safetyCopy}`);
}

// Also remove any stale WAL/SHM files so SQLite doesn't try to replay a
// write-ahead log that belongs to the old database against the restored one.
for (const ext of ['-wal', '-shm']) {
  const stale = DB_PATH + ext;
  if (fs.existsSync(stale)) fs.unlinkSync(stale);
}

fs.copyFileSync(backupFile, DB_PATH);
console.log(`Restored database from: ${backupFile}`);
console.log('Restart the server for the change to take effect.');
