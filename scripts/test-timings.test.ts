// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { summary, timings } from "./test-timings.mjs";

const file = (name: string, seconds: number, status = "passed") => ({
  name: `/repo/${name}`,
  startTime: 1_000,
  endTime: 1_000 + seconds * 1_000,
  status,
});
const pass = (...files: ReturnType<typeof file>[]) => ({ testResults: files });

it("lists files slowest first by their slower pass, relative to the root", () => {
  const result = timings(
    [
      pass(file("a.test.ts", 2), file("b.test.ts", 9)),
      pass(file("a.test.ts", 30), file("b.test.ts", 8)),
    ],
    "/repo",
  );

  expect(result.unavailable).toEqual([]);
  expect(result.rows).toEqual([
    { file: "a.test.ts", seconds: [2, 30], failed: false },
    { file: "b.test.ts", seconds: [9, 8], failed: false },
  ]);
});

it("marks a file that failed in either pass", () => {
  const result = timings(
    [pass(file("a.test.ts", 1)), pass(file("a.test.ts", 1, "failed"))],
    "/repo",
  );

  expect(result.rows[0]?.failed).toBe(true);
  expect(summary(result)).toContain("| a.test.ts (failed) | 1.0 | 1.0 |");
});

it("says which pass has no timings when its report is missing or cut short, and keeps the other", () => {
  const cut = { testResults: [{ name: "/repo/a.test.ts", startTime: 1 }] };
  const result = timings([pass(file("a.test.ts", 4)), cut, undefined], "/repo");

  expect(result.unavailable).toEqual([2, 3]);
  expect(result.rows).toEqual([{ file: "a.test.ts", seconds: [4, null, null], failed: false }]);
  expect(summary(result)).toContain("Timings for pass 2 are unavailable");
  expect(summary(result)).toContain("| a.test.ts | 4.0 |  |  |");
});

it("says so when nothing was recorded", () => {
  const result = timings([undefined, undefined], "/repo");

  expect(summary(result)).toContain("No timings were recorded.");
});

it("shows at most the ten slowest and totals each pass", () => {
  const files = Array.from({ length: 12 }, (_, index) => file(`t${index}.test.ts`, index + 1));
  const text = summary(timings([pass(...files)], "/repo"));

  expect(text.split("\n").filter((line) => line.startsWith("| t"))).toHaveLength(10);
  expect(text).toContain("| t11.test.ts | 12.0 |");
  expect(text).not.toContain("| t0.test.ts |");
  expect(text).toContain("12 files; pass 1 78 s of test time.");
});
