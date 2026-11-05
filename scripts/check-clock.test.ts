// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("scripts/check rejects a future-expiring test while preserving explicit fake clocks", () => {
  const directory = mkdtempSync(join(tmpdir(), "spi-code-clock-"));
  const root = fileURLToPath(new URL("../", import.meta.url));
  const header = "// Copyright 2026, Daniel Scholl\n// SPDX-License-Identifier: MIT\n";
  const now = performance.timeOrigin + performance.now();
  const expiry = now + 200 * 24 * 60 * 60 * 1_000;
  const command = `"${process.execPath}" "${join(root, "node_modules/vitest/vitest.mjs")}" run --config "${join(root, "vitest.config.ts")}" --maxWorkers=1`;
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    cpSync(join(root, "scripts/check"), join(directory, "check"));
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "junction");
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ type: "module", scripts: { check: command, test: command } }),
    );
    const fixture = `${header}
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.useRealTimers());
it("expires at a fixed future date", () => {
  expect(Date.now()).toBeLessThan(${expiry});
  expect(new Date().getTime()).toBeLessThan(${expiry});
});
it("allows an explicit fake clock and advancing fake timers", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
  const start = Date.now();
  const callback = vi.fn();
  setTimeout(callback, 10);
  vi.advanceTimersByTime(10);
  expect(Date.now()).toBe(start + 10);
  expect(callback).toHaveBeenCalledOnce();
});
it("restores the shifted ticking clock after useRealTimers", async () => {
  const start = Date.now();
  const real = performance.timeOrigin + performance.now();
  const offset = process.env.SPI_TEST_CLOCK_SHIFT === "1" ? 400 * 86400000 : 0;
  expect(Math.abs(start - real - offset)).toBeLessThan(5000);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(Date.now()).toBeGreaterThan(start);
  expect(new Date().getTime()).toBeGreaterThan(start);
  expect(Math.abs(Date.parse(Date()) - Date.now())).toBeLessThan(1000);
  expect(Date.parse("2040-01-01T00:00:00Z")).toBe(Date.UTC(2040, 0, 1));
});
`;
    for (const project of [
      "scripts",
      "apps/desktop/src",
      "apps/window/src",
      "packages/contracts/src",
      "packages/core/src",
      "packages/host/src",
      "packages/tools/src",
    ]) {
      mkdirSync(join(directory, project), { recursive: true });
      writeFileSync(join(directory, project, "expiry.test.ts"), fixture);
    }
    const result = spawnSync("bash", ["check"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, SPI_TEST_CLOCK_SHIFT: "", VITEST_MAX_WORKERS: "1" },
      timeout: 90_000,
    });
    expect(result.error).toBeUndefined();
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(1);
    expect(output).toContain("21 passed");
    expect(output).toContain("wall clock 400 days forward");
    expect(output).toContain("7 failed | 14 passed");
    expect(output).toContain("expires at a fixed future date");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
