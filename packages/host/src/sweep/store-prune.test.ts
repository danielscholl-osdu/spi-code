// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { cacheSchema, createContext, emptyCache, type Facts } from "@spi-code/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { Sweeper } from "../../../core/src/sweep/sweeper.js";
import { createLeaseStore } from "../store/leases.js";
import { openStore } from "../store/open.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { DAY_MS, SweepService } from "./service.js";

let directory: string;
let db: DatabaseSync;
let service: SweepService;
const epoch = Date.parse("2026-11-12T00:00:00Z");
const scheduled: { ms: number; run: () => void }[] = [];
const onError = vi.fn();

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "spi-prune-"));
  db = openStore(join(directory, "store.sqlite"));
  scheduled.length = 0;
  onError.mockClear();
  const old = epoch - 8 * DAY_MS;
  createLeaseStore(db).acquire("old", "writer", 100, old);
  const snapshots = createSnapshotStore(db);
  const lease = { fleet: "old", owner: "writer", fence: 1 };
  snapshots.writeSnapshot(lease, {}, {}, old);
  snapshots.writeSnapshot(lease, {}, {}, old + 1);
  service = new SweepService({
    db,
    fleet: "test",
    ctx: createContext({ clock: { now: () => new Date(epoch) } }),
    appData: directory,
    exec: {
      runJSON: async () => ({ ok: false, error: "offline", code: 1 }),
      runText: async () => ({ ok: false, error: "offline", code: 1 }),
    },
    factsSchema: z.custom<Facts>(),
    doctor: () => ({ state: "clear", problems: [] }),
    onError,
    timers: {
      after(ms, run) {
        scheduled.push({ ms, run });
        return () => {};
      },
    },
    createSweeper: (options) => new Sweeper({ ...options, areas: [], cacheSchema, emptyCache }),
  });
});

afterEach(async () => {
  await service.stop();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("reports a failed daily prune without rolling back the committed sweep snapshot", async () => {
  await expect(service.start()).resolves.toBe(true);
  const committed = service.latest();
  expect(committed?.cursor).toBe(3);
  const daily = scheduled.find(({ ms }) => ms === DAY_MS);
  if (!daily) throw new Error("Daily prune was not scheduled");
  db.exec(`
    INSERT INTO facts_snapshots (fleet, at, facts, envelope, fence)
      VALUES ('old', 0, '{}', '{}', 1);
    CREATE TRIGGER fail_prune BEFORE DELETE ON facts_snapshots
      BEGIN SELECT RAISE(ABORT, 'injected prune failure'); END;
  `);
  daily.run();
  await vi.waitFor(() =>
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "injected prune failure" }),
    ),
  );
  expect(service.latest()).toEqual(committed);
  expect(db.isTransaction).toBe(false);
  expect(
    createSnapshotStore(db)
      .snapshotsSince(0)
      .map(({ cursor }) => cursor),
  ).toEqual([2, 3, 4]);
});
