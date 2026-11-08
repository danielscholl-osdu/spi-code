// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";
import { configuredProjects, projectSummary, unresolvedEnvironments } from "./vitest-projects.mjs";

const projects = configuredProjects(config.test?.projects);

function readReport(path: string) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { testResults: [] };
}

describe("vitest project diagnostics", () => {
  const window = { name: "apps/window", directory: "apps/window/src", environment: "happy-dom" };
  const scripts = { name: "scripts", directory: "scripts", environment: "node" };
  const passing = Array.from({ length: 4 }, () => ({ status: "passed" }));

  it("reads every configured project with its directory and environment", () => {
    expect(projects).toContainEqual(window);
    expect(projects).toContainEqual(scripts);
    expect(projects.map((p) => p.directory)).toContain("packages/core/src");
  });

  it("names a project that produced no results", () => {
    const summary = projectSummary(
      [scripts, window],
      { testResults: [{ name: "/fixture/scripts/expiry.test.ts", assertionResults: passing }] },
      "/fixture",
      { passed: 4, failed: 0 },
    );
    expect(summary.problems).toEqual([
      "vitest project apps/window is missing: no results (expected 4 passed, 0 failed)",
    ]);
    expect(summary.text).toContain("expected 2 (scripts, apps/window), found 1");
    expect(summary.text).toContain("apps/window: missing");
  });

  it("names a project whose counts differ and carries its suite error", () => {
    const summary = projectSummary(
      [scripts, window],
      {
        testResults: [
          { name: "/fixture/scripts/expiry.test.ts", assertionResults: passing },
          {
            name: "/fixture/apps/window/src/expiry.test.ts",
            status: "failed",
            message: "Cannot find package 'happy-dom'",
            assertionResults: [],
          },
        ],
      },
      "/fixture",
      { passed: 4, failed: 0 },
    );
    expect(summary.problems).toEqual([
      "vitest project apps/window has 0 passed, 0 failed (expected 4 passed, 0 failed): Cannot find package 'happy-dom'",
    ]);
  });

  it("names a project whose environment package does not resolve", () => {
    const directory = mkdtempSync(join(tmpdir(), "spi-code-env-"));
    try {
      expect(unresolvedEnvironments([scripts, window], directory)).toEqual([
        `vitest project apps/window runs in happy-dom, but package happy-dom does not resolve from ${join(directory, "node_modules")}; run pnpm install`,
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

it.each(["2040-01-01T00:00:00.998Z", "2040-01-01T00:00:00.999Z"])(
  "scripts/check rejects expiry and another zone, and preserves fake clocks with Date text sampled at %s",
  (boundary) => {
    const directory = mkdtempSync(join(tmpdir(), "spi code clock-"));
    const root = fileURLToPath(new URL("../", import.meta.url));
    const header = "// Copyright 2026, Daniel Scholl\n// SPDX-License-Identifier: MIT\n";
    const now = performance.timeOrigin + performance.now();
    const expiry = now + 200 * 24 * 60 * 60 * 1_000;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const args = [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      join(root, "vitest.config.ts"),
      "--maxWorkers=1",
      "--reporter=default",
      "--reporter=json",
    ];
    try {
      execFileSync("git", ["init", "--quiet", directory]);
      cpSync(join(root, "scripts/check"), join(directory, "check"));
      symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "junction");
      expect(unresolvedEnvironments(projects, directory)).toEqual([]);
      writeFileSync(
        join(directory, "run-vitest.mjs"),
        `${header}
import { spawnSync } from "node:child_process";
const result = spawnSync(process.execPath, [...${JSON.stringify(args)}, "--outputFile.json=" + process.argv[2]], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status === null) throw new Error("Vitest terminated by signal " + result.signal);
process.exitCode = result.status;
`,
      );
      mkdirSync(join(directory, "scripts"), { recursive: true });
      writeFileSync(
        join(directory, "scripts/third-party-notices.mjs"),
        `${header}\nconsole.log("third-party notices: fixture stub ran");\n`,
      );
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            check: "node run-vitest.mjs check.json",
            test: "node run-vitest.mjs test.json",
          },
        }),
      );
      const fixture = `${header}
import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.useRealTimers());
function expectDateString(advance = () => {}) {
  const before = Date.now();
  const text = Date();
  advance();
  const after = Date.now();
  const parsed = Date.parse(text);
  expect(parsed).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
  expect(parsed).toBeLessThanOrEqual(Math.floor(after / 1000) * 1000);
}
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
  expectDateString();
  expect(Date.parse("2040-01-01T00:00:00Z")).toBe(Date.UTC(2040, 0, 1));
});
it("accepts Date text sampled before or across a simulated second boundary", () => {
  const start = Date.parse(${JSON.stringify(boundary)});
  vi.useFakeTimers();
  vi.setSystemTime(start);
  expectDateString(() => vi.advanceTimersByTime(1));
  expect(Date.now()).toBe(start + 1);
});
it("reads the time zone scripts/check started in", () => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(${JSON.stringify(zone)});
});
`;
      for (const project of projects) {
        mkdirSync(join(directory, project.directory), { recursive: true });
        writeFileSync(join(directory, project.directory, "expiry.test.ts"), fixture);
      }
      const result = spawnSync("bash", ["check"], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, SPI_TEST_CLOCK_SHIFT: "", VITEST_MAX_WORKERS: "1" },
        timeout: 90_000,
      });
      expect(result.error).toBeUndefined();
      const output = result.stdout + result.stderr;
      const ran = realpathSync.native(directory);
      for (const [report, expected] of [
        ["check.json", { passed: 5, failed: 0 }],
        ["test.json", { passed: 3, failed: 2 }],
      ] as const) {
        const summary = projectSummary(
          projects,
          readReport(join(directory, report)),
          ran,
          expected,
        );
        expect(summary.problems, `${report}\n${summary.text}\n\n${output}`).toEqual([]);
      }
      expect(result.status, output).toBe(1);
      expect(output).not.toContain("third-party notices: fixture stub ran");
      expect(output).toContain(`${projects.length * 5} passed`);
      const shifted = output.indexOf("wall clock 400 days forward");
      expect(shifted, output).toBeGreaterThan(-1);
      const shiftedOutput = output.slice(shifted);
      expect(shiftedOutput).toContain(
        `${projects.length * 2} failed | ${projects.length * 3} passed`,
      );
      expect(shiftedOutput).toContain("expires at a fixed future date");
      expect(shiftedOutput).toContain("reads the time zone scripts/check started in");
      expect(shiftedOutput).toMatch(/ELIFECYCLE\s+Test failed/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
