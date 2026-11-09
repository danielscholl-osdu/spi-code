// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchSmoke } from "./smoke-launch.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

it.each([false, true])("isolates and cleans Electron user-data even on failure (%s)", (fail) => {
  let directory = "";
  const failure = new Error("Fixture Electron failure");
  vi.mocked(execFileSync).mockImplementationOnce((_executable, args, options) => {
    directory = args?.find((arg) => arg.startsWith("--user-data-dir="))?.slice(16) ?? "";
    expect(existsSync(directory)).toBe(true);
    writeFileSync(join(directory, "fixture.sqlite"), "fixture");
    expect(args).toContain("--smoke");
    expect(options).toMatchObject({
      env: { PATH: "fixture" },
      timeout: 240000,
      killSignal: "SIGKILL",
    });
    expect(options?.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    if (fail) throw failure;
    return Buffer.alloc(0);
  });
  const run = () =>
    launchSmoke("fixture-electron", [], { PATH: "fixture", ELECTRON_RUN_AS_NODE: "1" });
  if (fail) expect(run).toThrow(failure);
  else expect(run).not.toThrow();
  expect(directory).not.toBe("");
  expect(existsSync(directory)).toBe(false);
});
