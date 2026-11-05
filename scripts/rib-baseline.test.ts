// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { testCounts } from "./rib-baseline.mjs";

const xml = `<testsuites tests="3" assertions="7" failures="0" skipped="0" time="8.5">
  <testsuite file="test/a.test.ts" tests="2" assertions="5" failures="0" skipped="0">
    <testsuite file="test/a.test.ts" tests="2" assertions="5" failures="0" skipped="0">
    </testsuite>
  </testsuite>
  <testsuite file="test/b.test.ts" tests="1" assertions="2" failures="0" skipped="0">
  </testsuite>
</testsuites>`;
const summary = "3 pass\n0 fail\nRan 3 tests across 2 files. [8.50s]";

describe("recorded rib test counts", () => {
  it("counts each file once without nested suites, durations or machine identity", () => {
    expect(testCounts(xml, summary)).toEqual({
      files: [
        { file: "test/a.test.ts", tests: 2, assertions: 5, failures: 0, skipped: 0 },
        { file: "test/b.test.ts", tests: 1, assertions: 2, failures: 0, skipped: 0 },
      ],
      total: { files: 2, tests: 3, assertions: 7, failures: 0, skipped: 0 },
    });
    expect(testCounts(xml.replace('time="8.5"', 'time="12.9"'), summary)).toEqual(
      testCounts(xml, summary),
    );
  });

  it("rejects missing summaries and disagreements with bun test", () => {
    expect(() => testCounts(xml, "")).toThrow("must print its summary");
    expect(() => testCounts(xml, summary.replace("Ran 3", "Ran 4"))).toThrow("totals must match");
    expect(() => testCounts(xml, summary.replace("2 files", "3 files"))).toThrow(
      "counts must match",
    );
    expect(() => testCounts(xml.replace('tests="3"', 'tests="4"'), summary)).toThrow("must add up");
  });

  it("rejects truncated reports and non-count attributes", () => {
    expect(() =>
      testCounts(xml.replace("  </testsuite>\n</testsuites>", "</testsuites>"), summary),
    ).toThrow("must be closed");
    expect(() => testCounts(xml.replace('tests="3"', 'tests="unknown"'), summary)).toThrow(
      "must be a count",
    );
  });
});
