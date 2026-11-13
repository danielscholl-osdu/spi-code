// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { cacheSchema, createContext, emptyCache, Sweeper } from "@spi-code/core";
import { z } from "zod";
import { openStore } from "../../dist/store/open.js";
import { SweepService } from "../../dist/sweep/service.js";

const [path, appData, at, mode] = process.argv.slice(2);
const db = openStore(path);
assert.equal(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys, 1);
assert.equal(db.prepare("PRAGMA busy_timeout").get()?.timeout, 5000);
const service = new SweepService({
  db,
  fleet: "test",
  ctx: createContext({ clock: { now: () => new Date(Number(at)) } }),
  appData,
  doctor: () => ({ state: "clear", problems: [] }),
  ttlMs: 3000,
  factsSchema: z.unknown(),
  exec: {
    runText: async () => {
      throw new Error("Unexpected Exec");
    },
    runJSON: async () => {
      throw new Error("Unexpected Exec");
    },
  },
  onError: (error) => {
    throw error;
  },
  createSweeper: (options) =>
    new Sweeper({
      ...options,
      cacheSchema,
      emptyCache,
      areas: [
        {
          name: "auth",
          read: async () => ({
            data: {
              gh: { ok: true, detail: "signed in" },
              glab: { ok: true, detail: "signed in" },
            },
            reads: [],
          }),
        },
      ],
    }),
});
await service.start();
if (mode === "mid-write") {
  db.function("pause_snapshot", () => {
    writeSync(process.stdout.fd, "writing snapshot 2\n");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return 0;
  });
  db.exec(`CREATE TEMP TRIGGER pause_write AFTER INSERT ON facts_snapshots
    BEGIN SELECT pause_snapshot(); END;`);
  await service.sweep(true);
} else {
  process.stdout.write(`committed ${service.latest().cursor}\n`);
}
setInterval(() => {}, 60_000);
