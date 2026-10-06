// Restores the database from a backup file. Moves the current (possibly
// broken) database aside rather than deleting it, so a bad restore doesn't
// destroy your only other copy.
//
// Usage:
//   node scripts/restore.js backups/shifts-2026-08-31T10-00-00-000Z.db

const fs = require('fs');
const path = require('path');

function restore({
  backupFile,
  dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'shifts.db'),
  backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'),
}) {
  if (!backupFile) throw new Error(`Usage: node scripts/restore.js <path-to-backup-file>\nAvailable backups:\n${fs.existsSync(backupDir) ? fs.readdirSync(backupDir).map((file) => `  ${path.relative(path.join(__dirname, '..'), path.join(backupDir, file))}`).join('\n') : ''}`);
  if (!fs.existsSync(backupFile)) throw new Error(`Backup file not found: ${backupFile}`);

  let safetyCopy = null;
  if (fs.existsSync(dbPath)) {
    safetyCopy = `${dbPath}.before-restore-${Date.now()}`;
    fs.copyFileSync(dbPath, safetyCopy);
  console.log(`Current database backed up to: ${safetyCopy}`);
  }

  // Remove stale sidecars so they cannot be replayed against the restored file.
  for (const ext of ['-wal', '-shm']) {
    const stale = dbPath + ext;
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(backupFile, dbPath);
  console.log(`Restored database from: ${backupFile}`);
  console.log('Restart the server for the change to take effect.');
  return { dbPath, safetyCopy };
}

if (require.main === module) {
  try {
    restore({ backupFile: process.argv[2] });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { restore };
