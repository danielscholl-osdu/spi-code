// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import type { JobDetail } from "../src/facts";
import { type FailedAttempt, rerunNext, rerunRule } from "../src/model/rerun-rule";

function job(name: string, overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    id: name.length,
    name,
    status: "completed",
    conclusion: "failure",
    url: `https://github.com/o/r/actions/runs/1/job/${name.length}`,
    steps: [],
    environment: [],
    ...overrides,
  };
}

const deploy = (overrides: Partial<JobDetail> = {}) =>
  job("Deploy and Test", {
    failedStep: "Prove",
    reason: "Process completed with exit code 1.",
    ...overrides,
  });
const timeout = deploy({ environment: ["environment timeout"] });
const summary = job("Validation Summary", { reason: "Deploy and Test failed" });
const passed = job("Java Build", { conclusion: "success" });
const network = job("Java Build", { reason: "Error: connect ECONNRESET" });
const toolchain = job("Java Build", { reason: "RequireJavaVersion failed with message" });
const access = deploy({
  id: 99,
  failedStep: "Borrow",
  reason: "pull ghcr.io/azure/osdu-spi-indexer:1: manifest unknown",
});

const attempt = (
  jobs: JobDetail[] | undefined,
  more: Partial<FailedAttempt> = {},
): FailedAttempt => ({
  attempt: 1,
  jobs,
  complete: true,
  deployable: true,
  ...more,
});

test.each([
  [
    "a later attempt running",
    attempt([timeout, summary], { later: 2 }),
    "in-flight",
    "Environment",
  ],
  [
    "a later attempt over an unread job",
    attempt([deploy({ environment: undefined })], { later: 2 }),
    "in-flight",
    "Not read",
  ],
  [
    "a failed job's annotations unread",
    attempt([timeout, job("Java Build", { environment: undefined })]),
    "not-read",
    "Not read",
  ],
  ["an incomplete job list", attempt([timeout], { complete: false }), "not-read", "Not read"],
  ["no job list", attempt(undefined), "not-read", "Not read"],
  ["a failed run whose jobs all passed", attempt([passed]), "not-read", "Not read"],
  ["a mixed run with a TOOLCHAIN job", attempt([timeout, toolchain]), "real", "Real"],
  ["a mixed run with an ACCESS job", attempt([timeout, access]), "real", "Real"],

  ["an unannotated test failure", attempt([deploy()]), "real", "Real"],
  [
    "attempt 2 of an Environment failure",
    attempt([timeout], { attempt: 2 }),
    "retried",
    "Environment",
  ],
  ["attempt 2 of an INFRA failure", attempt([network], { attempt: 2 }), "retried", "No verdict"],
  ["INFRA with no Environment annotation", attempt([network]), "unverdicted", "No verdict"],
  [
    "an Environment failure, environment deployable",
    attempt([timeout, summary]),
    "eligible",
    "Environment",
  ],
  ["an Environment and an INFRA failure", attempt([timeout, network]), "eligible", "Environment"],
  [
    "an Environment failure, environment held",
    attempt([timeout], { deployable: false }),
    "held",
    "Environment",
  ],
])("%s is %s", (_, input, state, verdict) => {
  expect(rerunRule(input)).toMatchObject({ state, verdict });
});

test("a redundant summary job neither vetoes the rerun nor names the cause", () => {
  const judged = rerunRule(attempt([summary, timeout]));
  expect(judged).toMatchObject({ state: "eligible", reason: "environment timeout" });
  expect(judged.job?.name).toBe("Deploy and Test");
});

test("a real failure names its own job and class, and Next fixes it where the row's fix lands", () => {
  const judged = rerunRule(attempt([timeout, toolchain]));
  expect(judged).toMatchObject({ cls: "BUILD", job: { name: "Java Build" } });
  expect(rerunNext(judged, "Open the failed job", "main")).toBe(
    "Open the failed job, then fix it on main.",
  );
});

test("each state's Next sentence", () => {
  const next = (input: FailedAttempt) => rerunNext(rerunRule(input), "step", "main");
  expect(next(attempt([timeout], { later: 2 }))).toBe(
    "Re-run in flight (attempt 2). If it fails again, diagnose the failed jobs.",
  );
  expect(next(attempt([timeout], { complete: false }))).toBe(
    "Cause not read yet. Open the run attempt, or ask Copilot to diagnose.",
  );
  expect(next(attempt([timeout], { attempt: 2 }))).toBe(
    "Already retried once. Diagnose the failed jobs.",
  );
  expect(next(attempt([network]))).toBe(
    "Failed with no Environment verdict. Open the run attempt to decide.",
  );
  expect(next(attempt([timeout]))).toBe(
    "Re-run the failed jobs once. If it fails again, diagnose.",
  );
  expect(next(attempt([timeout], { deployable: false }))).toBe(
    "Re-run the failed jobs once the environment reads deployable.",
  );
});
