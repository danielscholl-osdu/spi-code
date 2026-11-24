// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createContext, type Facts } from "@spi-code/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { migrate } from "../store/migrations.js";
import { SweepService } from "./service.js";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "spi-wal-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("refuses a migrated connection that is not in WAL mode", () => {
  const memory = new DatabaseSync(":memory:");
  try {
    migrate(memory);
    expect(memory.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("memory");
    expect(
      () =>
        new SweepService({
          db: memory,
          fleet: "test",
          ctx: createContext(),
          appData: directory,
          exec: {
            runJSON: async () => ({ ok: false, error: "offline", code: 1 }),
            runText: async () => ({ ok: false, error: "offline", code: 1 }),
          },
          factsSchema: z.custom<Facts>(),
          doctor: () => ({ state: "clear", problems: [] }),
          onError: vi.fn(),
        }),
    ).toThrow(new Error("Sweep service requires a WAL store"));
  } finally {
    memory.close();
  }
});
