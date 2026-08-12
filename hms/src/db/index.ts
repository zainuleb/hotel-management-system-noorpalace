import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { DB_PATH, ensureDirs } from '../config.js';
import { SCHEMA_SQL } from './schema.js';

/**
 * Thin, synchronous wrapper over the database.
 *
 * Everything in the app goes through this module and never touches
 * `node:sqlite` directly, so swapping the driver (e.g. to better-sqlite3, or to
 * SQL Server for a multi-property install) is a change to this one file.
 */

let database: DatabaseSync | null = null;
const stmtCache = new Map<string, StatementSync>();

export function openDatabase(): DatabaseSync {
  if (database) return database;
  ensureDirs();
  database = new DatabaseSync(DB_PATH);
  // WAL keeps readers (reports, the room grid) from blocking the front desk.
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec('PRAGMA synchronous = NORMAL;');
  return database;
}

export function db(): DatabaseSync {
  return database ?? openDatabase();
}

function prepared(sql: string): StatementSync {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db().prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

type Param = string | number | bigint | null | Uint8Array;

/** node:sqlite hands back null-prototype rows; normalise to plain objects. */
function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

export function all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
  return prepared(sql).all(...params).map((r) => plain<T>(r));
}

export function get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
  const row = prepared(sql).get(...params);
  return row === undefined ? undefined : plain<T>(row);
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export function run(sql: string, ...params: Param[]): RunResult {
  const res = prepared(sql).run(...params);
  return {
    changes: Number(res.changes),
    lastInsertRowid: Number(res.lastInsertRowid),
  };
}

export function exec(sql: string): void {
  db().exec(sql);
}

/** Scalar helper: `count('SELECT COUNT(*) AS n FROM rooms')`. */
export function scalar(sql: string, ...params: Param[]): number {
  const row = get<Record<string, unknown>>(sql, ...params);
  if (!row) return 0;
  const first = Object.values(row)[0];
  return typeof first === 'number' ? first : Number(first ?? 0);
}

/**
 * Runs `fn` inside an IMMEDIATE transaction. Nested calls join the outer
 * transaction rather than starting a new one.
 */
let txDepth = 0;
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  const conn = db();
  conn.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* the transaction was already rolled back by SQLite */
    }
    throw err;
  } finally {
    txDepth--;
  }
}

/** Atomically increments a named counter and returns the new value. */
export function nextCounter(name: string): number {
  run(
    `INSERT INTO counters(name, value) VALUES(?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1`,
    name,
  );
  return scalar('SELECT value FROM counters WHERE name = ?', name);
}

export function initSchema(): void {
  openDatabase();
  exec(SCHEMA_SQL);
  runMigrations();
  seedExpenseCategories();
}

/**
 * The expense headings from the hotel's own monthly report sheet. Seeded once,
 * on an empty table only, renaming or adding to them afterwards is the
 * owner's business and is never overwritten.
 */
const DEFAULT_EXPENSE_CATEGORIES: [string, 'expense' | 'income'][] = [
  ['Salaries', 'expense'],
  ['Utility Bills', 'expense'],
  ['Kitchen Expense', 'expense'],
  ['General Expense', 'expense'],
  ['Laundry Expense', 'expense'],
  ['Maintenance', 'expense'],
  ['Other Income', 'income'],
];

function seedExpenseCategories(): void {
  if (scalar('SELECT COUNT(*) FROM expense_categories') > 0) return;
  let order = 0;
  for (const [name, kind] of DEFAULT_EXPENSE_CATEGORIES) {
    run('INSERT INTO expense_categories (name, kind, sort_order) VALUES (?,?,?)', name, kind, order++);
  }
}

/**
 * Additive migrations for installs already in the field. `SCHEMA_SQL` above is
 * always the current shape; anything listed here brings an older file forward.
 * Append new entries, never edit or reorder existing ones.
 */
const MIGRATIONS: { id: number; up: () => void }[] = [
  // { id: 1, up: () => exec(`ALTER TABLE rooms ADD COLUMN view TEXT NOT NULL DEFAULT ''`) },
];

function runMigrations(): void {
  const current = scalar('PRAGMA user_version');
  for (const m of MIGRATIONS) {
    if (m.id > current) {
      tx(() => {
        m.up();
        exec(`PRAGMA user_version = ${m.id}`);
      });
    }
  }
}

export function closeDatabase(): void {
  stmtCache.clear();
  database?.close();
  database = null;
}
