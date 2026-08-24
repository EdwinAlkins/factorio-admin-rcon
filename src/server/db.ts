import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "@/server/config/env";

/**
 * Stockage local : sessions révocables, journal d'audit et séries de métriques.
 *
 * `node:sqlite` est intégré à Node 22+ : aucune dépendance native à compiler,
 * ce qui garde l'image Docker simple. Une seule instance du panneau écrit dans
 * ce fichier (voir la section « modèle de sécurité » du README).
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

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATIONS);
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

/** Utilisé par les tests pour repartir d'une base vierge. */
export function setDb(db: DatabaseSync | undefined) {
  globalRef.__factorioDb = db;
}
