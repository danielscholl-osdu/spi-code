// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertNoProcessListeners, type Exec } from "./smoke-listeners.js";
import {
  publishRuntimeProbe,
  scanAfterRuntimeReport,
  waitForFile,
  waitForRuntimeReport,
} from "./smoke-runtime-report.js";

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

it("rejects with the report's error, not the process-tree error, once the failed host is replaced", async () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const scanError = new Error("Packaged smoke found TCP listeners: 7:127.0.0.1:4000");
    await expect(
      publishRuntimeProbe(report, handshake, async () => {
        throw new AggregateError([scanError], "Packaged runtime probe failed");
      }),
    ).rejects.toThrow("Packaged runtime probe failed");
    const originalHost = 250;
    const exec = vi.fn<Exec>(async () => ({
      status: 0,
      stdout: [
        "  100     1 /Applications/SPI Code.app/Contents/MacOS/SPI Code --smoke",
        "  200   100 SPI Code Helper (Renderer) --type=renderer",
        "  300   100 SPI Code Helper --type=utility",
      ].join("\n"),
      stderr: "",
    }));
    const scan = () => assertNoProcessListeners(100, originalHost, { exec });
    await expect(scan()).rejects.toThrow("Smoke host is outside the app process tree");

    await expect(scanAfterRuntimeReport(report, 5000, scan)).rejects.toThrow(
      "Packaged runtime probe failed: Packaged smoke found TCP listeners: 7:127.0.0.1:4000",
    );
    expect(exec).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
});

it("scans after a passing report, and without a report outside the packaged app", async () => {
  await publishRuntimeProbe(report, handshake, async () => ({ listeners: [] }));
  const scan = vi.fn(async () => "scanned");
  await expect(scanAfterRuntimeReport(report, 5000, scan)).resolves.toBe("scanned");
  await expect(scanAfterRuntimeReport(undefined, 5000, scan)).resolves.toBe("scanned");
  expect(scan).toHaveBeenCalledTimes(2);
});
