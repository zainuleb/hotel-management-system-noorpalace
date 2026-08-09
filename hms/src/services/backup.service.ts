import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, DB_PATH, config, ensureDirs } from '../config.js';
import { closeDatabase, db, exec, initSchema } from '../db/index.js';
import { nowTs } from '../lib/dates.js';

/**
 * Backups use SQLite's `VACUUM INTO`, which writes a consistent, already
 * compacted copy while the system keeps running — no need to stop the front
 * desk to take one.
 */

export interface BackupFile {
  name: string;
  size_bytes: number;
  created_at: string;
}

function stamp(): string {
  return nowTs().replace(/[:\s]/g, '-');
}

export function createBackup(label = 'manual'): BackupFile {
  ensureDirs();
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '') || 'manual';
  const name = `hms-${stamp()}-${safeLabel}.sqlite`;
  const target = path.join(BACKUP_DIR, name);
  // VACUUM INTO refuses to overwrite, which is the behaviour we want.
  db().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const stat = fs.statSync(target);
  pruneBackups();
  return { name, size_bytes: stat.size, created_at: nowTs() };
}

export function listBackups(): BackupFile[] {
  ensureDirs();
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return {
        name: f,
        size_bytes: stat.size,
        created_at: new Date(stat.mtimeMs).toISOString().slice(0, 19).replace('T', ' '),
      };
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function pruneBackups(): void {
  const files = listBackups();
  for (const file of files.slice(config.backupRetention)) {
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, file.name));
    } catch {
      /* a locked file will be pruned on the next run */
    }
  }
}

export function backupPath(name: string): string {
  // Never let a request escape the backup folder.
  const safe = path.basename(name);
  const full = path.join(BACKUP_DIR, safe);
  if (!full.startsWith(BACKUP_DIR)) throw new Error('Invalid backup name');
  if (!fs.existsSync(full)) throw new Error('That backup file no longer exists.');
  return full;
}

/**
 * Replaces the live database with a backup. A safety copy of the current
 * database is taken first, so a mistaken restore is itself reversible.
 */
export function restoreBackup(name: string): { restored: string; safetyCopy: string } {
  const source = backupPath(name);
  const safety = createBackup('before-restore');

  closeDatabase();
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${DB_PATH}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  fs.copyFileSync(source, DB_PATH);
  initSchema();
  exec('PRAGMA foreign_keys = ON;');

  return { restored: path.basename(source), safetyCopy: safety.name };
}

export function deleteBackup(name: string): void {
  fs.unlinkSync(backupPath(name));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Takes one automatic backup at start-up and then one every 24 hours, so an
 * install that is simply left running still produces daily snapshots.
 */
export function startBackupSchedule(): void {
  const run = () => {
    try {
      createBackup('auto');
    } catch (err) {
      console.error('[hms] automatic backup failed:', err);
    }
  };
  setTimeout(run, 10_000).unref();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
