// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

// Turns the vitest JSON reports scripts/check leaves in SPI_CHECK_REPORT_DIR into timings.json
// and a Markdown summary of the slowest test files. It reports; it never decides a result.
//   node scripts/test-timings.mjs <report directory>
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {{ file: string, seconds: (number | null)[], failed: boolean }} Row */

/**
 * @param {unknown} report one pass's vitest JSON report, or undefined when it is missing
 * @returns {{ name: string, seconds: number, failed: boolean }[] | undefined}
 */
function filesOf(report) {
  const results = /** @type {{ testResults?: unknown }} */ (report ?? {}).testResults;
  if (!Array.isArray(results)) return undefined;
  const files = [];
  for (const result of results) {
    const { name, startTime, endTime, status } = /** @type {Record<string, unknown>} */ (result);
    if (typeof name !== "string" || typeof startTime !== "number" || typeof endTime !== "number") {
      return undefined;
    }
    files.push({
      name,
      seconds: Math.max(0, endTime - startTime) / 1000,
      failed: status !== "passed",
    });
  }
  return files;
}

/**
 * One row per test file, slowest first by its slower pass.
 * @param {unknown[]} reports the passes in order; an unreadable pass is undefined
 * @param {string} root paths are reported relative to this
 * @returns {{ rows: Row[], unavailable: number[] }} unavailable holds the one-based passes without a usable report
 */
export function timings(reports, root) {
  /** @type {Map<string, Row>} */
  const rows = new Map();
  /** @type {number[]} */
  const unavailable = [];
  reports.forEach((report, pass) => {
    const files = filesOf(report);
    if (files === undefined) {
      unavailable.push(pass + 1);
      return;
    }
    for (const { name, seconds, failed } of files) {
      const file = relative(root, name).split("\\").join("/");
      const row = rows.get(file) ?? { file, seconds: reports.map(() => null), failed: false };
      row.seconds[pass] = seconds;
      row.failed ||= failed;
      rows.set(file, row);
    }
  });
  const slowest = (/** @type {Row} */ row) => Math.max(...row.seconds.map((value) => value ?? 0));
  return { rows: [...rows.values()].sort((a, b) => slowest(b) - slowest(a)), unavailable };
}

/**
 * @param {{ rows: Row[], unavailable: number[] }} result
 * @param {number} [count]
 */
export function summary({ rows, unavailable }, count = 10) {
  const lines = ["### Slowest test files", ""];
  for (const pass of unavailable) {
    lines.push(`Timings for pass ${pass} are unavailable: its report is missing or cut short.`, "");
  }
  const [first] = rows;
  if (first === undefined) return [...lines, "No timings were recorded."].join("\n");
  const passes = first.seconds.map((_, pass) => pass);
  const cell = (/** @type {number | null} */ value) => (value === null ? "" : value.toFixed(1));
  lines.push(`| File | ${passes.map((pass) => `Pass ${pass + 1} (s)`).join(" | ")} |`);
  lines.push(`|---|${passes.map(() => "---:").join("|")}|`);
  for (const row of rows.slice(0, count)) {
    lines.push(
      `| ${row.file}${row.failed ? " (failed)" : ""} | ${row.seconds.map(cell).join(" | ")} |`,
    );
  }
  const total = (/** @type {number} */ pass) =>
    rows.reduce((sum, row) => sum + (row.seconds[pass] ?? 0), 0);
  lines.push(
    "",
    `${rows.length} files; ${passes.map((pass) => `pass ${pass + 1} ${total(pass).toFixed(0)} s`).join(", ")} of test time.`,
  );
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) {
    console.error("usage: node scripts/test-timings.mjs <report directory>");
    process.exit(2);
  }
  const reports = ["pass-1.json", "pass-2.json"].map((name) => {
    try {
      return JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch {
      return undefined;
    }
  });
  const result = timings(reports, process.cwd());
  try {
    writeFileSync(join(directory, "timings.json"), `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // The directory is missing when the check stopped before its tests; the summary says so.
  }
  console.log(summary(result));
}
