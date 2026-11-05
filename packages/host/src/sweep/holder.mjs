// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { DatabaseSync } from "node:sqlite";
import { cacheSchema, createContext, emptyCache, Sweeper } from "@spi-code/core";
import { z } from "zod";
import { SweepService } from "../../dist/sweep/service.js";

const [path, appData, at] = process.argv.slice(2);
const db = new DatabaseSync(path);
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
process.stdout.write(`committed ${service.latest().cursor}\n`);
setInterval(() => {}, 60_000);
