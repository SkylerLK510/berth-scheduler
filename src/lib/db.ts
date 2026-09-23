// Database access. libSQL speaks SQLite, so the same code runs against a local
// file during development and tests, and against a hosted Turso database in production.
//
//   TURSO_DATABASE_URL  libsql://<db>-<org>.turso.io   (defaults to file:local.db)
//   TURSO_AUTH_TOKEN    token from `turso db tokens create <db>` (not needed for files)
//
// A file database is not durable on serverless hosts like Vercel (the filesystem is
// read-only or thrown away between requests), so production refuses to start with one.

import { createClient, type Client, type Transaction } from "@libsql/client";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS berths (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  length_ft  REAL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes      TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS vessels (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  length_ft REAL,
  notes     TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reservations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  berth_id        INTEGER NOT NULL REFERENCES berths(id),
  vessel_id       INTEGER REFERENCES vessels(id),
  title           TEXT    NOT NULL DEFAULT '',
  start_date      TEXT    NOT NULL,
  end_date        TEXT    NOT NULL,
  notes           TEXT    NOT NULL DEFAULT '',
  source          TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'import')),
  source_ref      TEXT,
  confirmed       INTEGER NOT NULL DEFAULT 1,
  known_dates     TEXT, -- comma-separated days the spreadsheet shows, for unconfirmed stays
  override_reason TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (end_date >= start_date),
  CHECK (vessel_id IS NOT NULL OR title <> '')
);
CREATE INDEX IF NOT EXISTS reservations_berth_dates ON reservations (berth_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS reservations_vessel ON reservations (vessel_id);
CREATE INDEX IF NOT EXISTS reservations_dates ON reservations (start_date, end_date);

CREATE TABLE IF NOT EXISTS day_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  berth_id   INTEGER REFERENCES berths(id),
  date       TEXT    NOT NULL,
  text       TEXT    NOT NULL,
  source     TEXT    NOT NULL DEFAULT 'manual',
  source_ref TEXT
);
CREATE INDEX IF NOT EXISTS day_notes_date ON day_notes (date);

-- Dispatcher sessions (see auth.ts). Only a hash of each token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash       TEXT    PRIMARY KEY,
  passcode_version TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL
);

-- Shared counter of failed sign-ins in the current window (one row).
CREATE TABLE IF NOT EXISTS login_throttle (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  window_start INTEGER NOT NULL,
  failures     INTEGER NOT NULL
);
`;
// Note: references are checked in code (repo.ts) rather than with PRAGMA foreign_keys,
// because that pragma is per connection and the hosted client doesn't keep one open.

let client: Client | null = null;
let ready: Promise<void> | null = null;

export function databaseUrl(): string {
  return process.env.TURSO_DATABASE_URL ?? "file:local.db";
}

export function storageKind(): "file" | "remote" {
  return databaseUrl().startsWith("file:") ? "file" : "remote";
}

function connect(): Client {
  if (process.env.VERCEL && storageKind() === "file") {
    throw new Error("TURSO_DATABASE_URL is not set. A file database won't persist on Vercel; see the README.");
  }
  return createClient({ url: databaseUrl(), authToken: process.env.TURSO_AUTH_TOKEN });
}

/**
 * Databases created before known_dates existed stored the known days as one
 * known_start..known_end range. That range can't be trusted: joined stays had gaps inside
 * it, and edits clamped its ends to dates a person typed. So legacy unconfirmed stays get
 * no known dates at all. Every day is treated as estimated, which can only turn a
 * conflict into a possible one, never invent a definite one, until someone confirms
 * the dates or re-imports the sheet into a fresh database.
 */
async function migrate(conn: Client): Promise<void> {
  const columns = (await conn.execute("PRAGMA table_info(reservations)")).rows.map((r) => String(r.name));
  if (!columns.includes("known_dates")) await conn.execute("ALTER TABLE reservations ADD COLUMN known_dates TEXT");
}

/** Returns the shared client, creating the tables the first time it is used. */
export async function db(): Promise<Client> {
  if (!client) client = connect();
  if (!ready) {
    const conn = client;
    ready = conn.executeMultiple(SCHEMA).then(() => migrate(conn)).catch((err) => {
      ready = null; // let the next call retry instead of caching the failure
      throw err;
    });
  }
  await ready;
  return client;
}

/** Test helper: point the module at a different database. */
export function resetDbForTests(url: string): void {
  client = createClient({ url });
  ready = null;
}

const BUSY_RETRIES = 12;

function isBusy(err: unknown): boolean {
  const text = String(err instanceof Error ? err.message : err).toLowerCase();
  return text.includes("sqlite_busy") || text.includes("database is locked");
}

/**
 * Run `work` inside a write transaction (BEGIN IMMEDIATE), committing or rolling back
 * depending on what it returns. SQLite allows one writer at a time, so a second
 * transaction that starts while another is running gets SQLITE_BUSY; it waits and
 * retries, and because the retry re-runs `work`, it sees whatever the first one wrote.
 *
 * The wait is an async sleep on purpose. The local driver's own busy timeout would
 * block the Node event loop while it waits, and the transaction holding the lock needs
 * that same event loop to finish and commit.
 */
export async function withWriteTransaction<T>(work: (tx: Transaction) => Promise<{ commit: boolean; value: T }>): Promise<T> {
  const conn = await db();
  for (let attempt = 0; ; attempt++) {
    let tx: Transaction | null = null;
    try {
      tx = await conn.transaction("write");
      const { commit, value } = await work(tx);
      if (commit) await tx.commit();
      else await tx.rollback();
      return value;
    } catch (err) {
      if (tx && !tx.closed) await tx.rollback().catch(() => {});
      if (isBusy(err) && attempt < BUSY_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(20 * 2 ** attempt, 500) + Math.random() * 25));
        continue;
      }
      throw err;
    } finally {
      tx?.close();
    }
  }
}
