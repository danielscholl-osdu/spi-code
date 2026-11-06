// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { publishRuntimeProbe, waitForFile, waitForRuntimeReport } from "./smoke-runtime-report.js";

let dir: string;
let report: string;
const handshake = { hostPid: 42, transport: "stdio" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spi-runtime-report-"));
  report = join(dir, "runtime.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("waits for a file and fails when it never appears", async () => {
  const waiting = waitForFile(report, 5000);
  setTimeout(() => writeFileSync(report, "{}"), 150);
  await expect(waiting).resolves.toBeUndefined();
  await expect(waitForFile(join(dir, "missing.json"), 150)).rejects.toThrow("Timed out");
});

it("publishes a passing listener check atomically and hands it to the desktop", async () => {
  const listenerCheck = { runtimePids: [7], listeners: [] };
  const desktop = waitForRuntimeReport(report, 5000);
  await publishRuntimeProbe(report, handshake, async () => listenerCheck);
  await expect(desktop).resolves.toEqual({ ...handshake, listenerCheck });
  expect(existsSync(`${report}.partial`)).toBe(false);
});

it("gives the desktop the first host's scan error at once while the replacement host writes nothing", async () => {
  const scanError = new Error("Packaged smoke found TCP listeners: 7:127.0.0.1:4000");
  const desktop = waitForRuntimeReport(report, 15000);
  const desktopSettled = desktop.then(
    () => performance.now(),
    () => performance.now(),
  );
  const started = performance.now();
  const firstHost = publishRuntimeProbe(report, handshake, async () => {
    throw new AggregateError([scanError], "Packaged runtime probe failed");
  });
  await expect(firstHost).rejects.toThrow("Packaged runtime probe failed");
  let replacementRunning = true;
  const replacementHost = setTimeout(() => {
    replacementRunning = false;
  }, 15000);
  try {
    await expect(desktop).rejects.toThrow(
      "Packaged runtime probe failed: Packaged smoke found TCP listeners: 7:127.0.0.1:4000",
    );
    expect(replacementRunning).toBe(true);
  } finally {
    clearTimeout(replacementHost);
  }
  expect((await desktopSettled) - started).toBeLessThan(2000);
  expect(JSON.parse(readFileSync(report, "utf8"))).toMatchObject({
    ...handshake,
    failure: { message: expect.stringContaining("found TCP listeners") },
  });
  expect(existsSync(`${report}.partial`)).toBe(false);
});
