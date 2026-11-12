// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openStore } from "./open.js";
import { createRunStore } from "./store.js";

let directory: string;
let path: string;
const databases: DatabaseSync[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "spi-open-"));
  path = join(directory, "store.sqlite");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("returns a migrated connection with every durability pragma set explicitly", () => {
  const execute = DatabaseSync.prototype.exec;
  const initialized = new WeakSet<DatabaseSync>();
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    if (!initialized.has(this)) {
      initialized.add(this);
      execute.call(
        this,
        "PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=0",
      );
    }
    execute.call(this, sql);
  });
  const db = openStore(path);
  databases.push(db);
  expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  expect(db.prepare("SELECT version FROM schema_version ORDER BY version").all()).toEqual([
    { version: 1 },
    { version: 2 },
    { version: 3 },
    { version: 4 },
  ]);
  const runs = createRunStore(db);
  runs.create({ id: "one", kind: "test", createdAt: "2026-11-12T00:00:00Z" });
  expect(runs.get("one")?.kind).toBe("test");
  expect(runs).not.toHaveProperty("close");
});

it("rejects an inaccessible file rather than returning a store", () => {
  expect(() => openStore(join(directory, "missing", "store.sqlite"))).toThrow(/unable to open/);
});

it("closes a connection that cannot enter WAL instead of returning a weaker store", () => {
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  expect(() => openStore(":memory:")).toThrow("SQLite WAL mode required; received memory");
  expect(close).toHaveBeenCalledOnce();
});

it("preserves the schema error and closes an unsupported store", () => {
  const db = new DatabaseSync(path);
  databases.push(db);
  db.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY) STRICT; INSERT INTO schema_version VALUES (99)",
  );
  const close = vi.spyOn(DatabaseSync.prototype, "close");
  expect(() => openStore(path)).toThrow("Unsupported schema version: 99");
  expect(close).toHaveBeenCalledOnce();
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='runs'").get()).toBeUndefined();
});

it("propagates a failed run read rather than claiming an absent record", () => {
  const db = openStore(path);
  databases.push(db);
  const store = createRunStore(db);
  db.close();
  expect(() => store.get("unknown")).toThrow();
});
