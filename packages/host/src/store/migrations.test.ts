// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "./migrations.js";
import { createSeenStore } from "./seen.js";

const v1 = `
  CREATE TABLE schema_version (version INTEGER PRIMARY KEY) STRICT;
  INSERT INTO schema_version VALUES (1);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, title TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE run_events (
    run_id TEXT NOT NULL REFERENCES runs(id),
    seq INTEGER NOT NULL CHECK (seq > 0 AND seq <= 9007199254740991),
    kind TEXT NOT NULL, message TEXT,
    data_json TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
    created_at TEXT NOT NULL, PRIMARY KEY (run_id, seq)
  ) STRICT;
  CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
  BEGIN SELECT RAISE(ABORT, 'run_events are append-only'); END;
  CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
  BEGIN SELECT RAISE(ABORT, 'run_events are append-only'); END;
  INSERT INTO runs VALUES ('run-1', 'turn', 'Existing run', 'before', 'after');
  INSERT INTO run_events VALUES ('run-1', 1, 'tool', NULL, '{"result":42}', 'before');
`;

describe("store migrations", () => {
  const databases: DatabaseSync[] = [];

  function open(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    databases.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it.each(["empty", "v1"] as const)(
    "migrates a %s database to the ten NF-04 tables and the seen baseline",
    (from) => {
      const db = open();
      if (from === "v1") db.exec(v1);
      const runs = from === "v1" ? db.prepare("SELECT * FROM runs").all() : [];
      const events = from === "v1" ? db.prepare("SELECT * FROM run_events").all() : [];
      migrate(db);
      expect(
        db
          .prepare(
            `SELECT name FROM sqlite_schema WHERE type = 'table'
           AND name NOT IN ('schema_version', 'sqlite_sequence') ORDER BY name`,
          )
          .all()
          .map((row) => row.name),
      ).toEqual([
        "approvals",
        "facts_snapshots",
        "intents",
        "leases",
        "messages",
        "run_events",
        "runs",
        "seen_baselines",
        "threads",
        "waits",
        "worktrees",
      ]);
      expect(db.prepare("SELECT * FROM runs").all()).toEqual(runs);
      expect(db.prepare("SELECT * FROM run_events").all()).toEqual(events);
      if (from === "v1") {
        expect(() => db.exec("UPDATE run_events SET message = 'changed'")).toThrow("append-only");
        expect(() => db.exec("DELETE FROM run_events")).toThrow("append-only");
      }
      const schema = db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
      migrate(db);
      expect(db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
      expect(db.prepare("SELECT version FROM schema_version ORDER BY version").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
      ]);
    },
  );

  it("keeps a v3 seen baseline readable, with no runs observation", () => {
    const db = open();
    migrate(db);
    db.exec("ALTER TABLE seen_baselines DROP COLUMN observed_at");
    db.exec("DELETE FROM schema_version WHERE version = 4");
    db.prepare("INSERT INTO seen_baselines (fleet, cursor, items, at) VALUES (?, ?, ?, ?)").run(
      "osdu",
      7,
      "[]",
      1_760_000_000_000,
    );
    migrate(db);
    const seen = createSeenStore(db);
    expect(seen.baseline("osdu")).toEqual({
      fleet: "osdu",
      cursor: 7,
      items: [],
      at: 1_760_000_000_000,
      observedAt: null,
    });
    expect(seen.acknowledge("osdu", 8, [], 1_760_000_100_000, 1_759_999_000_000)).toBe(true);
    expect(seen.baseline("osdu")?.observedAt).toBe(1_759_999_000_000);
  });

  it("rolls back v2 and v3 without changing v1 data or its migration ledger", () => {
    const db = open();
    db.exec(v1);
    db.exec("CREATE TABLE facts_snapshots (conflict TEXT)");
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
    const runs = db.prepare("SELECT * FROM runs").all();
    const events = db.prepare("SELECT * FROM run_events").all();
    expect(() => migrate(db)).toThrow(/already exists/);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
    expect(db.prepare("SELECT version FROM schema_version").all()).toEqual([{ version: 1 }]);
    expect(db.prepare("SELECT * FROM runs").all()).toEqual(runs);
    expect(db.prepare("SELECT * FROM run_events").all()).toEqual(events);
    db.exec("DROP TABLE facts_snapshots");
    migrate(db);
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version).toBe(4);
  });
});
