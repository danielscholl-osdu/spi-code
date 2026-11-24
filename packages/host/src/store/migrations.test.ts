// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLeaseStore } from "./leases.js";
import { migrate } from "./migrations.js";
import { openStore } from "./open.js";
import { createSeenStore } from "./seen.js";
import { createSnapshotStore } from "./snapshots.js";

/** Takes a migrated database back to v5, where every sweep added a snapshot row. */
function toV5(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE snapshots_shown;
    DROP INDEX facts_snapshots_fleet;
    CREATE INDEX facts_snapshots_fleet_cursor ON facts_snapshots (fleet, cursor);
    CREATE INDEX facts_snapshots_at ON facts_snapshots (at);
    DELETE FROM schema_version WHERE version >= 6;
  `);
}

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
        "snapshots_shown",
        "thread_workspaces",
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
        { version: 5 },
        { version: 6 },
      ]);
    },
  );

  it("keeps a v3 seen baseline readable, with no runs observation", () => {
    const db = open();
    migrate(db);
    toV5(db);
    db.exec("ALTER TABLE seen_baselines DROP COLUMN observed_at");
    db.exec("DROP TABLE thread_workspaces");
    db.exec("DELETE FROM schema_version WHERE version >= 4");
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
    expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version).toBe(6);
  });
});

describe("the v6 snapshot migration", () => {
  let directory: string;
  let path: string;

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function bytes(): number {
    const wal = `${path}-wal`;
    return statSync(path).size + (statSync(wal, { throwIfNoEntry: false })?.size ?? 0);
  }

  it("keeps each fleet's latest snapshot, drops the rest and shrinks the file once", () => {
    directory = mkdtempSync(join(tmpdir(), "spi-migrate-"));
    path = join(directory, "runs.sqlite");
    let db = openStore(path);
    toV5(db);
    const insert = db.prepare(
      "INSERT INTO facts_snapshots (fleet, at, facts, envelope, fence) VALUES (?, ?, ?, ?, 1)",
    );
    const fleets = ["a", "b", "c"];
    for (let sweep = 0; sweep < 40; sweep++) {
      for (const fleet of fleets) {
        const facts = JSON.stringify({ fleet, sweep, cache: "x".repeat(64 * 1024) });
        insert.run(fleet, 1000 + sweep, facts, JSON.stringify({ sweep }));
      }
    }
    const latest = db
      .prepare(
        "SELECT * FROM facts_snapshots WHERE cursor IN (SELECT MAX(cursor) FROM facts_snapshots GROUP BY fleet) ORDER BY cursor",
      )
      .all();
    expect(latest.map((row) => row.cursor)).toEqual([118, 119, 120]);
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.close();
    const before = bytes();
    expect(before).toBeGreaterThan(120 * 64 * 1024);

    db = openStore(path);
    try {
      expect(db.prepare("SELECT * FROM facts_snapshots ORDER BY cursor").all()).toEqual(latest);
      expect(db.prepare("SELECT COUNT(*) AS count FROM snapshots_shown").get()?.count).toBe(0);
      expect(db.prepare("SELECT MAX(version) AS version FROM schema_version").get()?.version).toBe(
        6,
      );
      expect(bytes()).toBeLessThan(before / 10);
      createLeaseStore(db).acquire("a", "sweeper", 100, 2000);
      const next = createSnapshotStore(db).writeSnapshot(
        { fleet: "a", owner: "sweeper", fence: 1 },
        {},
        {},
        2001,
      );
      expect(next).toBe(121);
    } finally {
      db.close();
    }

    const statements: string[] = [];
    const execute = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      statements.push(sql);
      execute.call(this, sql);
    });
    openStore(path).close();
    expect(statements.filter((sql) => /VACUUM/i.test(sql))).toEqual([]);
  });
});
