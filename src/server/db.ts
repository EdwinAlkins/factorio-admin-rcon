import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "@/server/config/env";

/**
 * Local storage: revocable sessions, audit log and metric series.
 *
 * `node:sqlite` ships with Node 22+, so there is no native dependency to
 * compile and the Docker image stays simple. A single panel instance writes to
 * this file (see the "security model" section of the README).
 */

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  role        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  username    TEXT NOT NULL,
  role        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  action      TEXT NOT NULL,
  command     TEXT,
  command_hash TEXT,
  status      TEXT NOT NULL,
  detail      TEXT,
  duration_ms INTEGER,
  ip          TEXT,
  request_id  TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log (ts DESC);

CREATE TABLE IF NOT EXISTS metrics (
  ts          INTEGER PRIMARY KEY,
  cpu_percent REAL,
  mem_bytes   INTEGER,
  mem_limit   INTEGER,
  players     INTEGER,
  game_tick   INTEGER,
  ups         REAL
);
`;

/**
 * Columns added after the fact. `CREATE TABLE IF NOT EXISTS` does not touch an
 * existing table, so without this catch-up a panel upgrade on an existing
 * database would fail on a missing column.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: "audit_log", column: "command_hash", definition: "TEXT" },
];

function addMissingColumns(db: DatabaseSync) {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as {
      name: string;
    }[];

    if (columns.some((existing) => existing.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATIONS);
  addMissingColumns(db);
  return db;
}

const globalRef = globalThis as typeof globalThis & { __factorioDb?: DatabaseSync };

export function getDb(): DatabaseSync {
  if (globalRef.__factorioDb) return globalRef.__factorioDb;

  const dir = env().DATA_DIR;
  mkdirSync(dir, { recursive: true });
  globalRef.__factorioDb = openDatabase(join(dir, "admin.db"));
  return globalRef.__factorioDb;
}

/** Used by the tests to start from a clean database. */
export function setDb(db: DatabaseSync | undefined) {
  globalRef.__factorioDb = db;
}
