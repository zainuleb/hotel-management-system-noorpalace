import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the application root regardless of whether we are running from
 * `src/` (dev, via --experimental-strip-types) or `dist/` (production build).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  /** Port the front-desk PC listens on. Staff browse to http://<pc-ip>:PORT */
  port: envInt('HMS_PORT', 8080),
  /** 0.0.0.0 so other machines on the hotel LAN can reach it. */
  host: process.env.HMS_HOST ?? '0.0.0.0',
  /** Where the SQLite file and backups live. */
  dataDir: process.env.HMS_DATA_DIR ?? path.join(APP_ROOT, 'data'),
  viewsDir: path.join(APP_ROOT, 'views'),
  publicDir: path.join(APP_ROOT, 'public'),
  /** Session lifetime. A hotel shift is long, so default to 12 hours. */
  sessionHours: envInt('HMS_SESSION_HOURS', 12),
  /** Keep this many automatic backups before pruning the oldest. */
  backupRetention: envInt('HMS_BACKUP_RETENTION', 30),
  isProduction: process.env.NODE_ENV === 'production',
};

export const DB_PATH = path.join(config.dataDir, 'hms.sqlite');
export const BACKUP_DIR = path.join(config.dataDir, 'backups');

export function ensureDirs(): void {
  for (const dir of [config.dataDir, BACKUP_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
