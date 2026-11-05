// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLeaseStore } from "./leases.js";
import { openRunStore } from "./store.js";

let directory: string;
let path: string;
let db: DatabaseSync;
const children: ChildProcess[] = [];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "spi-code-leases-"));
  path = join(directory, "store.sqlite");
  openRunStore(path).close();
  db = new DatabaseSync(path);
});

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }),
  );
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

async function worker(owner: string): Promise<ChildProcess> {
  const child = fork(new URL("./fixtures/lease-worker.mjs", import.meta.url), [path, owner], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    timeout: 5000,
    killSignal: "SIGKILL",
  });
  children.push(child);
  expect((await once(child, "message"))[0]).toBe("ready");
  return child;
}

async function acquire(child: ChildProcess, now: number): Promise<unknown> {
  const reply = once(child, "message");
  child.send({ now });
  return (await reply)[0];
}

it("checks owner and fence, expires exactly at ttl, and never reuses a released fence", () => {
  const leases = createLeaseStore(db);
  expect(leases.acquire("a", "first", 100, 1000)).toBe(1);
  expect(leases.acquire("a", "first", 100, 1001)).toBeUndefined();
  expect(leases.acquire("a", "second", 100, 1099)).toBeUndefined();
  expect(leases.acquire("b", "second", 100, 1000)).toBe(1);
  for (const [owner, fence] of [
    ["other", 1],
    ["first", 2],
  ] as const) {
    expect(leases.renew("a", owner, fence, 100, 1050)).toBe(false);
    expect(leases.release("a", owner, fence)).toBe(false);
  }
  expect(leases.renew("a", "first", 1, 100, 1050)).toBe(true);
  expect(leases.acquire("a", "second", 100, 1149)).toBeUndefined();
  expect(leases.renew("a", "first", 1, 100, 1150)).toBe(false);
  expect(leases.acquire("a", "second", 100, 1150)).toBe(2);
  expect(leases.renew("a", "first", 1, 100, 1151)).toBe(false);
  expect(leases.release("a", "first", 1)).toBe(false);
  expect(leases.release("a", "second", 2)).toBe(true);
  expect(leases.release("a", "second", 2)).toBe(false);
  db.close();
  db = new DatabaseSync(path);
  expect(createLeaseStore(db).acquire("a", "second", 100, 1151)).toBe(3);
});

it("gives exactly one owner to two forked processes racing acquire", async () => {
  const [a, b] = await Promise.all([worker("first"), worker("second")]);
  const results = await Promise.all([acquire(a, 1000), acquire(b, 1000)]);
  expect(results.sort()).toEqual([1, null]);
  expect(db.prepare("SELECT fence, expires_at FROM leases").all()).toEqual([
    { fence: 1, expires_at: 1100 },
  ]);
}, 8000);

it("does not recover a SIGKILLed owner's lease before its injected expiry", async () => {
  const owner = await worker("first");
  expect(await acquire(owner, 1000)).toBe(1);
  const exited = once(owner, "exit");
  owner.kill("SIGKILL");
  expect(await exited).toEqual([null, "SIGKILL"]);
  const next = await worker("second");
  expect(await acquire(next, 1099)).toBeNull();
  expect(await acquire(next, 1100)).toBe(2);
}, 8000);

it("rejects invalid clocks and ttl without changing ownership", () => {
  const leases = createLeaseStore(db);
  for (const ttl of [0, -1, 0.5, Infinity]) {
    expect(() => leases.acquire("a", "owner", ttl, 1000)).toThrow(RangeError);
  }
  for (const now of [NaN, 0.5, Number.MAX_SAFE_INTEGER]) {
    expect(() => leases.acquire("a", "owner", 100, now)).toThrow(RangeError);
  }
  expect(db.prepare("SELECT * FROM leases").all()).toEqual([]);
});
