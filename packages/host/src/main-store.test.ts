// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SetupServiceOptions } from "./setup/service.js";
import type { SweepServiceOptions } from "./sweep/service.js";

const wiring = vi.hoisted(() => ({
  opens: [] as string[],
  watch: [] as { db: () => DatabaseSync }[],
  setup: [] as SetupServiceOptions[],
  sweep: [] as SweepServiceOptions[],
}));
vi.mock("node:sqlite", async (original) => {
  const actual = await original<typeof import("node:sqlite")>();
  return {
    DatabaseSync: class extends actual.DatabaseSync {
      constructor(path: string) {
        wiring.opens.push(path);
        super(path);
      }
    },
  };
});
vi.mock("./process/routes.js", () => ({
  watchFleet: () => "test",
  WatchRoutes: class {
    routes = {};
    constructor(options: { db: () => DatabaseSync }) {
      wiring.watch.push(options);
    }
    sweeper() {
      return undefined;
    }
  },
}));
vi.mock("./setup/service.js", () => ({
  SetupService: class {
    routes = {};
    constructor(options: SetupServiceOptions) {
      wiring.setup.push(options);
    }
  },
}));
vi.mock("./sweep/service.js", () => ({
  SweepService: class {
    constructor(options: SweepServiceOptions) {
      wiring.sweep.push(options);
    }
  },
}));

let directory: string;
let path: string;
let onExit: (() => void) | undefined;
const originalArgs = process.argv;
const originalParent = Object.getOwnPropertyDescriptor(process, "parentPort");
let connected: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  for (const entries of Object.values(wiring)) entries.length = 0;
  directory = mkdtempSync(join(tmpdir(), "spi-main-store-"));
  path = join(directory, "store.sqlite");
  connected = vi.fn();
  Object.defineProperty(process, "parentPort", { value: { on: connected }, configurable: true });
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "exit") onExit = listener as () => void;
    return process;
  });
});

afterEach(() => {
  onExit?.();
  onExit = undefined;
  process.argv = originalArgs;
  if (originalParent) Object.defineProperty(process, "parentPort", originalParent);
  else Reflect.deleteProperty(process, "parentPort");
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

it("opens the host file once for the probe, Watch and every SweepService", async () => {
  const report = join(directory, "report.json");
  process.argv = ["node", "host", path, "write", "row", report, "--stub-model", "--smoke"];
  await import("./main.js");
  const watch = wiring.watch[0];
  const setup = wiring.setup[0];
  if (!watch || !setup) throw new Error("Missing host wiring");
  const db = watch.db();
  expect(watch.db()).toBe(db);
  setup.createSweep();
  setup.createSweep();
  expect(wiring.sweep.map((options) => options.db)).toEqual([db, db]);
  expect(wiring.opens.filter((opened) => opened === path)).toEqual([path]);
  expect(db.prepare("SELECT id FROM runs").all()).toEqual([{ id: "row" }]);
  expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
    rowSurvived: true,
    sqliteIsTransaction: true,
  });
  onExit?.();
  onExit = undefined;
  expect(db.isOpen).toBe(false);
});

it.each(["unopenable", "non-WAL", "unknown schema"])(
  "refuses to start on %s, propagating the store error without connecting the host",
  async (failure) => {
    let expected: RegExp;
    if (failure === "unopenable") {
      path = join(directory, "missing", "store.sqlite");
      expected = /unable to open/;
    } else if (failure === "non-WAL") {
      path = ":memory:";
      expected = /SQLite WAL mode required; received memory/;
    } else {
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY) STRICT; INSERT INTO schema_version VALUES (99)",
      );
      db.close();
      expected = /Unsupported schema version: 99/;
    }
    process.argv = ["node", "host", path];
    await expect(import("./main.js")).rejects.toThrow(expected);
    expect(wiring.watch).toEqual([]);
    expect(wiring.setup).toEqual([]);
    expect(wiring.sweep).toEqual([]);
    expect(connected).not.toHaveBeenCalled();
  },
);
