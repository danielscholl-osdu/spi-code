// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { DatabaseSync } from "node:sqlite";

const migrations = [
  `
    CREATE TABLE runs (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE run_events (
      run_id TEXT NOT NULL REFERENCES runs(id),
      seq INTEGER NOT NULL CHECK (seq > 0 AND seq <= 9007199254740991),
      kind TEXT NOT NULL,
      message TEXT,
      data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    ) STRICT;
    CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
    BEGIN SELECT RAISE(ABORT, 'run_events are append-only'); END;
    CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
    BEGIN SELECT RAISE(ABORT, 'run_events are append-only'); END;
  `,
  `
    CREATE TABLE threads (
      id TEXT PRIMARY KEY NOT NULL,
      fleet TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE intents (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY NOT NULL,
      intent_id TEXT NOT NULL REFERENCES intents(id),
      state TEXT NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE waits (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES runs(id),
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL REFERENCES threads(id),
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE leases (
      fleet TEXT PRIMARY KEY NOT NULL,
      owner TEXT,
      fence INTEGER NOT NULL CHECK (fence >= 0 AND fence <= 9007199254740991),
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE facts_snapshots (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      fleet TEXT NOT NULL,
      at INTEGER NOT NULL,
      facts TEXT NOT NULL CHECK (json_valid(facts)),
      envelope TEXT NOT NULL CHECK (json_valid(envelope)),
      fence INTEGER NOT NULL CHECK (fence > 0 AND fence <= 9007199254740991)
    ) STRICT;
    CREATE INDEX facts_snapshots_fleet_cursor ON facts_snapshots (fleet, cursor);
    CREATE INDEX facts_snapshots_at ON facts_snapshots (at);
  `,
  `
    CREATE TABLE seen_baselines (
      fleet TEXT PRIMARY KEY NOT NULL,
      cursor INTEGER NOT NULL CHECK (cursor > 0 AND cursor <= 9007199254740991),
      items TEXT NOT NULL CHECK (json_valid(items)),
      at INTEGER NOT NULL
    ) STRICT;
  `,
  `
    ALTER TABLE seen_baselines ADD COLUMN observed_at INTEGER;
  `,
];

export function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY) STRICT");
    const versions = db.prepare("SELECT version FROM schema_version ORDER BY version").all();
    for (const [index, row] of versions.entries()) {
      if (row.version !== index + 1 || index >= migrations.length) {
        throw new Error(`Unsupported schema version: ${row.version}`);
      }
    }
    for (const [index, migration] of migrations.entries()) {
      if (index < versions.length) continue;
      db.exec(migration);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(index + 1);
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
