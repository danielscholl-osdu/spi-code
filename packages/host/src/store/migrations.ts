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
