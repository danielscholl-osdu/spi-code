// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, expect, it, vi } from "vitest";

const { startHost } = vi.hoisted(() => ({ startHost: vi.fn() }));
vi.mock("./host.js", () => ({ startHost }));
const argv = process.argv;
afterEach(() => {
  process.argv = argv;
  vi.resetModules();
  startHost.mockClear();
});

it.each([
  [[], { storePath: "", stub: false, smoke: false }],
  [["data.sqlite"], { storePath: "data.sqlite", stub: false, smoke: false }],
  [
    ["--smoke", "data.sqlite", "write", "row", "report.json", "--stub-model"],
    {
      storePath: "data.sqlite",
      stub: true,
      smoke: true,
      probe: { phase: "write", rowId: "row", reportPath: "report.json" },
    },
  ],
])("parses host arguments %j", async (args, expected) => {
  process.argv = ["node", "host", ...args];
  await import("./main.js");
  expect(startHost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
});

it.each([
  ["db", "read"],
  ["db", "read", "row"],
])("refuses incomplete smoke arguments %j", async (...args) => {
  process.argv = ["node", "host", ...args];
  await expect(import("./main.js")).rejects.toThrow(
    "Smoke probe requires a row id and report path",
  );
  expect(startHost).not.toHaveBeenCalled();
});
