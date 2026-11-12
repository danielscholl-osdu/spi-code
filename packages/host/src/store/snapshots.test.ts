// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLeaseStore } from "./leases.js";
import { openStore } from "./open.js";
import { createSnapshotStore } from "./snapshots.js";
import { openRunStore } from "./store.js";

let directory: string;
let path: string;
let db: DatabaseSync;
const first = { fleet: "a", owner: "first", fence: 1 };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "spi-code-snapshots-"));
  path = join(directory, "store.sqlite");
  openRunStore(path).close();
  db = new DatabaseSync(path);
  createLeaseStore(db).acquire("a", "first", 100, 1000);
});

afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("persists JSON and a global increasing cursor across reopen, deletion and fleets", () => {
  let snapshots = createSnapshotStore(db);
  expect(snapshots.latestSnapshot("a")).toBeUndefined();
  expect(snapshots.writeSnapshot(first, { repos: ["a"] }, { complete: true }, 1001)).toBe(1);
  db.close();
  db = new DatabaseSync(path);
  snapshots = createSnapshotStore(db);
  expect(snapshots.latestSnapshot("a")).toEqual({
    cursor: 1,
    fleet: "a",
    at: 1001,
    facts: { repos: ["a"] },
    envelope: { complete: true },
    fence: 1,
  });
  expect(snapshots.writeSnapshot(first, {}, {}, 1002)).toBe(2);
  createLeaseStore(db).acquire("b", "second", 100, 1000);
  expect(snapshots.writeSnapshot({ fleet: "b", owner: "second", fence: 1 }, {}, {}, 1003)).toBe(3);
  expect(snapshots.snapshotsSince(1).map((row) => row.cursor)).toEqual([2, 3]);
  expect(snapshots.latestSnapshot("a")?.cursor).toBe(2);
  expect(snapshots.snapshotsSince(3)).toEqual([]);
  db.exec("DELETE FROM facts_snapshots");
  db.close();
  db = new DatabaseSync(path);
  expect(createSnapshotStore(db).writeSnapshot(first, {}, {}, 1004)).toBe(4);
});

it("rejects missing, non-owner, expired, superseded and released leases", () => {
  const snapshots = createSnapshotStore(db);
  for (const lease of [
    { ...first, fleet: "missing" },
    { ...first, owner: "other" },
    { ...first, fence: 2 },
  ]) {
    expect(() => snapshots.writeSnapshot(lease, {}, {}, 1001)).toThrow("Stale lease");
  }
  expect(() => snapshots.writeSnapshot(first, {}, {}, 1100)).toThrow("Stale lease");
  const leases = createLeaseStore(db);
  expect(leases.acquire("a", "second", 100, 1100)).toBe(2);
  expect(() => snapshots.writeSnapshot(first, {}, {}, 1101)).toThrow("Stale lease");
  const second = { fleet: "a", owner: "second", fence: 2 };
  expect(snapshots.writeSnapshot(second, {}, {}, 1101)).toBe(1);
  expect(leases.release("a", "second", 2)).toBe(true);
  expect(() => snapshots.writeSnapshot(second, {}, {}, 1102)).toThrow("Stale lease");
});

it.each(["ABORT", "ROLLBACK"])("rolls back both row and allocated cursor on %s", (action) => {
  const snapshots = createSnapshotStore(db);
  expect(snapshots.writeSnapshot(first, {}, {}, 1001)).toBe(1);
  db.exec(`CREATE TRIGGER fail_snapshot AFTER INSERT ON facts_snapshots
    BEGIN SELECT RAISE(${action}, 'injected snapshot failure'); END;`);
  expect(() => snapshots.writeSnapshot(first, {}, {}, 1002)).toThrow("injected snapshot failure");
  expect(db.isTransaction).toBe(false);
  expect(snapshots.snapshotsSince(0).map((row) => row.cursor)).toEqual([1]);
  expect(
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'facts_snapshots'").get()?.seq,
  ).toBe(1);
  db.exec("DROP TRIGGER fail_snapshot");
  db.close();
  db = new DatabaseSync(path);
  expect(createSnapshotStore(db).writeSnapshot(first, {}, {}, 1003)).toBe(2);
});

it("rejects invalid JSON, clocks and cursors without advancing the cursor", () => {
  const snapshots = createSnapshotStore(db);
  for (const value of [undefined, () => null, 1n]) {
    expect(() => snapshots.writeSnapshot(first, value, {}, 1001)).toThrow();
    expect(() => snapshots.writeSnapshot(first, {}, value, 1001)).toThrow();
  }
  for (const value of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => snapshots.writeSnapshot(first, {}, {}, value)).toThrow(RangeError);
    expect(() => snapshots.writeSnapshot(first, {}, {}, () => value)).toThrow(RangeError);
    expect(db.isTransaction).toBe(false);
    expect(() => snapshots.snapshotsSince(value)).toThrow(RangeError);
  }
  expect(() => snapshots.snapshotsSince(-1)).toThrow(RangeError);
  expect(snapshots.writeSnapshot(first, {}, {}, 1001)).toBe(1);
});

it.each([1050, 1100])(
  "samples the clock after acquiring the writer lock (now: %s)",
  (afterLock) => {
    const snapshots = createSnapshotStore(db);
    let now = 1001;
    const execute = db.exec.bind(db);
    const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
      execute(sql);
      if (sql === "BEGIN IMMEDIATE") now = afterLock;
    });
    const clock = vi.fn(() => {
      expect(db.isTransaction).toBe(true);
      return now;
    });
    try {
      if (afterLock === 1100) {
        expect(() => snapshots.writeSnapshot(first, {}, {}, clock)).toThrow("Stale lease");
        expect(snapshots.latestSnapshot("a")).toBeUndefined();
      } else {
        expect(snapshots.writeSnapshot(first, {}, {}, clock)).toBe(1);
        expect(snapshots.latestSnapshot("a")?.at).toBe(afterLock);
      }
      expect(clock).toHaveBeenCalledOnce();
      expect(db.isTransaction).toBe(false);
    } finally {
      spy.mockRestore();
    }
  },
);

it("prunes snapshots strictly beyond seven days but retains each fleet's latest cursor", () => {
  let store = createSnapshotStore(db);
  const now = Date.parse("2026-11-05T04:00:00.000Z");
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
  db.close();
  db = openStore(path);
  store = createSnapshotStore(db);
  store.pruneSnapshots(now + 2);
  expect(db.prepare("SELECT cursor FROM facts_snapshots ORDER BY cursor").all()).toEqual([
    { cursor: 3 },
    { cursor: 5 },
    { cursor: 7 },
  ]);
});

it("rejects invalid pruning clocks without deleting snapshots", () => {
  const store = createSnapshotStore(db);
  db.exec(
    `INSERT INTO facts_snapshots (fleet, at, facts, envelope, fence)
       VALUES ('a', 0, '{}', '{}', 1), ('a', 1, '{}', '{}', 1)`,
  );
  for (const now of [Number.NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => store.pruneSnapshots(now)).toThrow(RangeError);
  }
  expect(db.prepare("SELECT COUNT(*) AS count FROM facts_snapshots").get()?.count).toBe(2);
});
