// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { workflowFailure } from "../src/model/index";

const run = (minute: number, conclusion: string | undefined, attempt = 1) => ({
  createdAt: `2026-11-17T16:${String(minute).padStart(2, "0")}:00Z`,
  status: conclusion ? "completed" : "in_progress",
  conclusion,
  attempt,
});
const failed = run(20, "failure");
const timedOut = run(20, "timed_out");
const cancelled = run(21, "cancelled");
const running = run(22, undefined);
const success = run(21, "success");
const retry = run(20, "success", 2);

test.each([
  ["a later success", [success, failed], undefined],
  ["a cancelled and running retry", [running, cancelled, failed], failed],
  ["a cancellation after a timeout", [cancelled, timedOut], timedOut],
  ["a cancelled run after a success", [cancelled, run(19, "success")], undefined],
  ["no finished runs", [running], undefined],
  ["two attempts of the same run", [retry, failed], undefined],
  [
    "a passing retry whose start is unread",
    [
      { ...run(19, "success", 2), id: 7 },
      { ...run(20, "failure"), id: 7 },
    ],
    undefined,
  ],
] as const)("reduces %s by start time and attempt", (_case, runs, expected) => {
  expect(workflowFailure(runs)).toBe(expected);
});

test("resolves each run's decisive attempt before comparing runs, in any input order", () => {
  const firstAttempt = { ...run(10, "failure"), startedAt: "2026-11-17T16:10:00Z", id: 1 };
  const passingRetry = { ...run(8, "success", 2), id: 1 };
  const otherRun = { ...run(9, "failure"), id: 2 };
  for (const order of [
    [firstAttempt, passingRetry, otherRun],
    [firstAttempt, otherRun, passingRetry],
    [passingRetry, firstAttempt, otherRun],
    [passingRetry, otherRun, firstAttempt],
    [otherRun, firstAttempt, passingRetry],
    [otherRun, passingRetry, firstAttempt],
  ]) {
    expect(workflowFailure(order)).toBeUndefined();
  }
});
