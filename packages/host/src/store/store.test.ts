// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "./migrations.js";
import { openRunStore, type RunStore } from "./store.js";

describe("file-backed run store", () => {
  let directory: string;
  let path: string;
  const stores: RunStore[] = [];
  const databases: DatabaseSync[] = [];
  const children: { child: ChildProcess; exited: Promise<unknown> }[] = [];
  const at = "2026-11-05T04:00:00.000Z";
  const later = "2026-11-05T04:01:00.000Z";

  function open(): RunStore {
    const store = openRunStore(path);
    stores.push(store);
    return store;
  }

  function inspect(): DatabaseSync {
    const db = new DatabaseSync(path);
    databases.push(db);
    return db;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "spi-code-store-"));
    path = join(directory, "runs.sqlite");
  });

  afterEach(async () => {
    for (const { child, exited } of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    for (const store of stores.splice(0)) store.close();
    for (const db of databases.splice(0)) db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("applies migrations once and preserves their records and schema on reopen", () => {
    const store = open();
    const db = inspect();
    const migrations = db.prepare("SELECT * FROM schema_version").all();
    expect(migrations).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const schema = db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all();
    store.close();
    open();
    expect(db.prepare("SELECT * FROM schema_version").all()).toEqual(migrations);
    expect(db.prepare("SELECT name, sql FROM sqlite_schema ORDER BY name").all()).toEqual(schema);
  });

  it("sets synchronous=FULL on the store's own connection", () => {
    const originalExec = DatabaseSync.prototype.exec;
    let connection: DatabaseSync | undefined;
    const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (!connection) {
        connection = this;
        originalExec.call(this, "PRAGMA synchronous = NORMAL");
      }
      originalExec.call(this, sql);
    });
    try {
      open();
      if (!connection) throw new Error("Store connection was not captured");
      expect(connection.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    } finally {
      exec.mockRestore();
    }
  });

  it("reads a run and events after close/reopen and continues its sequence", () => {
    let store = open();
    const run = { id: "run-1", kind: "turn", title: "SPI status", createdAt: at };
    store.create(run);
    expect(store.appendEvent(run.id, { kind: "text", message: "hello" }, at)).toBe(1);
    expect(store.appendEvent(run.id, { kind: "tool", data: { bytes: 12 } }, later)).toBe(2);
    store.close();
    store = open();
    expect(store.get(run.id)).toEqual({ ...run, updatedAt: later });
    expect(store.listEvents(run.id, 0)).toEqual([
      { seq: 1, kind: "text", message: "hello", data: null, createdAt: at },
      { seq: 2, kind: "tool", message: null, data: { bytes: 12 }, createdAt: later },
    ]);
    expect(store.listEvents(run.id, 1).map((event) => event.seq)).toEqual([2]);
    expect(store.appendEvent(run.id, { kind: "text", message: "again" }, later)).toBe(3);
    expect(store.lastSeq(run.id)).toBe(3);
    expect(store.get("missing")).toBeUndefined();
  });

  it("preserves every committed event with contiguous sequences after SIGKILL", async () => {
    const count = 12;
    const store = open();
    store.create({ id: "crash", kind: "turn", createdAt: at });
    store.close();
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./crash-writer.mjs", import.meta.url)), path, at],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = once(child, "close");
    children.push({ child, exited });
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr += text;
    });
    let committed = 0;
    try {
      child.stdin.write("append\n");
      for await (const line of lines) {
        committed += 1;
        expect(line).toBe(`committed ${committed}`);
        if (committed === count) {
          expect(child.kill("SIGKILL")).toBe(true);
          break;
        }
        child.stdin.write("append\n");
      }
      const [code, signal] = await exited;
      expect(stderr).not.toMatch(/Error/);
      expect({ code, signal }).toEqual({ code: null, signal: "SIGKILL" });
      expect(committed).toBe(count);
    } finally {
      lines.close();
    }
    const reopened = open();
    expect(reopened.listEvents("crash", 0)).toEqual(
      Array.from({ length: count }, (_, index) => ({
        seq: index + 1,
        kind: "text",
        message: `event ${index + 1}`,
        data: null,
        createdAt: at,
      })),
    );
    expect(reopened.lastSeq("crash")).toBe(count);
    expect(reopened.appendEvent("crash", { kind: "text" }, later)).toBe(count + 1);
  }, 60_000);

  it("pages strictly after the cursor in sequence order, independently per run and connection", () => {
    const store = open();
    store.create({ id: "a", kind: "turn", createdAt: at });
    store.create({ id: "b", kind: "turn", createdAt: at });
    const other = open();
    expect(store.appendEvent("a", { kind: "text" }, later)).toBe(1);
    expect(other.appendEvent("a", { kind: "text" }, at)).toBe(2);
    expect(other.appendEvent("b", { kind: "text" }, at)).toBe(1);
    expect(store.appendEvent("a", { kind: "text" }, at)).toBe(3);
    expect(store.listEvents("a", 1, 1).map((event) => event.seq)).toEqual([2]);
    expect(store.listEvents("a", 2).map((event) => event.seq)).toEqual([3]);
    expect(store.listEvents("a", 3)).toEqual([]);
    expect(store.listEvents("b", 0).map((event) => event.seq)).toEqual([1]);
    expect(store.lastSeq("missing")).toBe(0);
  });

  it("rolls back the event and sequence if updating the run fails", () => {
    const store = open();
    store.create({ id: "a", kind: "turn", createdAt: at });
    const db = inspect();
    db.exec(`
      CREATE TRIGGER fail_update BEFORE UPDATE ON runs
      BEGIN SELECT RAISE(ABORT, 'injected update failure'); END;
    `);
    expect(() => store.appendEvent("a", { kind: "text" }, later)).toThrow(
      "injected update failure",
    );
    expect(store.listEvents("a", 0)).toEqual([]);
    expect(store.get("a")?.updatedAt).toBe(at);
    db.exec("DROP TRIGGER fail_update");
    expect(store.appendEvent("a", { kind: "text" }, later)).toBe(1);
    store.close();
    expect(open().lastSeq("a")).toBe(1);
  });

  it("rejects unknown runs, duplicate runs and unserializable data without losing sequence", () => {
    const store = open();
    const run = { id: "a", kind: "turn", createdAt: at };
    expect(() => store.appendEvent("missing", { kind: "text" }, at)).toThrow(/FOREIGN KEY/);
    store.create(run);
    expect(() => store.create(run)).toThrow(/UNIQUE/);
    expect(() => store.appendEvent("a", { kind: "tool", data: 1n }, at)).toThrow(/BigInt/);
    expect(() => store.appendEvent("a", { kind: "tool", data: () => null }, at)).toThrow(
      "Event data must be JSON-serializable",
    );
    expect(store.appendEvent("a", { kind: "text" }, at)).toBe(1);
    expect(store.get("a")?.updatedAt).toBe(at);
  });

  it("enforces append-only events in SQLite", () => {
    const store = open();
    store.create({ id: "a", kind: "turn", createdAt: at });
    store.appendEvent("a", { kind: "text" }, at);
    const db = inspect();
    expect(() => db.exec("UPDATE run_events SET seq = 2")).toThrow("append-only");
    expect(() => db.exec("DELETE FROM run_events")).toThrow("append-only");
    expect(store.lastSeq("a")).toBe(1);
  });

  it("rejects invalid cursors and limits instead of silently truncating reads", () => {
    const store = open();
    for (const cursor of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.listEvents("a", cursor)).toThrow(RangeError);
    }
    for (const limit of [0, -1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => store.listEvents("a", 0, limit)).toThrow(RangeError);
    }
  });

  it("rolls back a failed migration and refuses a newer schema", () => {
    const db = inspect();
    db.exec("CREATE TABLE run_events (conflict TEXT)");
    expect(() => openRunStore(path)).toThrow(/already exists/);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'runs'").get()).toBeUndefined();
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'schema_version'").get(),
    ).toBeUndefined();
    db.exec("DROP TABLE run_events");
    open().close();
    db.exec("INSERT INTO schema_version VALUES (4)");
    expect(() => openRunStore(path)).toThrow("Unsupported schema version: 4");
    expect(db.prepare("SELECT version FROM schema_version ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ]);
  });

  it("preserves the append error when SQLite has already rolled back", () => {
    const store = open();
    store.create({ id: "a", kind: "turn", createdAt: at });
    const db = inspect();
    db.exec(`
      CREATE TRIGGER fail_update BEFORE UPDATE ON runs
      BEGIN SELECT RAISE(ROLLBACK, 'injected rollback failure'); END;
    `);
    expect(() => store.appendEvent("a", { kind: "text" }, later)).toThrow(
      "injected rollback failure",
    );
    expect(store.lastSeq("a")).toBe(0);
    expect(store.get("a")?.updatedAt).toBe(at);
    db.exec("DROP TRIGGER fail_update");
    expect(store.appendEvent("a", { kind: "text" }, later)).toBe(1);
  });

  it("preserves the migration error when SQLite has already rolled back", () => {
    const db = inspect();
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY) STRICT;
      CREATE TRIGGER fail_migration BEFORE INSERT ON schema_version
      BEGIN SELECT RAISE(ROLLBACK, 'injected migration rollback'); END;
    `);
    expect(() => migrate(db)).toThrow("injected migration rollback");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'runs'").get()).toBeUndefined();
  });

  it("refuses a database that cannot enable WAL", () => {
    expect(() => openRunStore(":memory:")).toThrow(/WAL/);
  });

  it("prunes snapshots strictly beyond seven days but retains each fleet's latest cursor", () => {
    const store = open();
    const db = inspect();
    const now = Date.parse(at);
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const insert = db.prepare(
      `INSERT INTO facts_snapshots (fleet, at, facts, envelope, fence)
       VALUES (?, ?, '{}', '{}', 1)`,
    );
    insert.run("a", cutoff - 1);
    insert.run("a", cutoff);
    insert.run("a", cutoff + 1);
    insert.run("b", cutoff - 100);
    insert.run("b", cutoff - 200);
    insert.run("c", cutoff - 100);
    insert.run("c", cutoff - 100);
    store.pruneSnapshots(now);
    expect(db.prepare("SELECT cursor FROM facts_snapshots ORDER BY cursor").all()).toEqual([
      { cursor: 2 },
      { cursor: 3 },
      { cursor: 5 },
      { cursor: 7 },
    ]);
    store.pruneSnapshots(now);
    expect(db.prepare("SELECT COUNT(*) AS count FROM facts_snapshots").get()?.count).toBe(4);
    store.close();
    open().pruneSnapshots(now + 2);
    expect(db.prepare("SELECT cursor FROM facts_snapshots ORDER BY cursor").all()).toEqual([
      { cursor: 3 },
      { cursor: 5 },
      { cursor: 7 },
    ]);
  });

  it("rejects invalid pruning clocks without deleting snapshots", () => {
    const store = open();
    const db = inspect();
    db.exec(
      `INSERT INTO facts_snapshots (fleet, at, facts, envelope, fence)
       VALUES ('a', 0, '{}', '{}', 1), ('a', 1, '{}', '{}', 1)`,
    );
    for (const now of [Number.NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => store.pruneSnapshots(now)).toThrow(RangeError);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM facts_snapshots").get()?.count).toBe(2);
  });
});
