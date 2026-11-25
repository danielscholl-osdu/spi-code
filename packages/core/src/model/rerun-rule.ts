// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { JobDetail } from "../facts.js";
import { judgeRun } from "../rollout.js";
import { classOf, type FailureClass } from "./attribution.js";
import { summarizeReason } from "./reason.js";

export type RerunState =
  | "in-flight"
  | "not-read"
  | "real"
  | "retried"
  | "unverdicted"
  | "eligible"
  | "held";

export type RerunVerdict = "Environment" | "Real" | "Not read" | "No verdict";

/** One failed run attempt, as main and the lanes both hold it. */
export interface FailedAttempt {
  attempt: number;
  jobs: readonly JobDetail[] | undefined;
  // The attempt's job list was read whole.
  complete: boolean;
  // A later attempt of the same run that is queued or running.
  later?: number;
  deployable: boolean;
}

export interface RerunJudgement {
  state: RerunState;
  verdict: RerunVerdict;
  attempt: number;
  later?: number;
  // The job the cause names, and its class when the run is real.
  job?: JobDetail;
  cls?: FailureClass;
  reason?: string;
}

// Validation Summary repeats the other jobs' result and never decides a run.
export const SUMMARY_JOB = "Validation Summary";
const FAILED: ReadonlySet<string> = new Set(["failure", "timed_out", "startup_failure"]);

export const failedJobs = (jobs: readonly JobDetail[] | undefined) =>
  (jobs ?? []).filter((job) => FAILED.has(job.conclusion ?? "") && job.name !== SUMMARY_JOB);

function settled(a: FailedAttempt): Omit<RerunJudgement, "attempt"> {
  const failed = failedJobs(a.jobs);
  const attempt = Math.max(a.attempt, ...failed.map((job) => job.attempt ?? 1));
  const judgement = a.complete && a.jobs
    ? judgeRun(failed.map((job) => ({ ...job, attempt })))
    : undefined;
  if (!judgement) return { state: "not-read", verdict: "Not read", ...(failed[0] ? { job: failed[0] } : {}) };
  const classed = failed.map((job) => ({ job, cls: classOf(job.name, "human", job.failedStep, job) }));
  const real = classed.find(({ job, cls }) => job.environment?.length === 0 && cls !== "ENV" && cls !== "INFRA");
  if (real) {
    const reason = summarizeReason(real.job.reason);
    return { state: "real", verdict: "Real", job: real.job, cls: real.cls, ...(reason ? { reason } : {}) };
  }
  const annotated = failed.find((job) => (job.environment?.length ?? 0) > 0);
  const cause = summarizeReason(judgement.cause ?? failed[0]?.reason);
  const named = { job: annotated ?? (failed[0] as JobDetail), ...(cause ? { reason: cause } : {}) };
  if (judgement.note) return { state: "retried", verdict: "Environment", ...named };
  if (judgement.class !== "environment") {
    return { state: attempt > 1 ? "retried" : "unverdicted", verdict: "No verdict", ...named, cls: classed[0]?.cls };
  }
  return { state: a.deployable ? "eligible" : "held", verdict: "Environment", ...named };
}

/** Whether a failed attempt is re-run once, in first-match order; never eligible on what was not read. */
export function rerunRule(a: FailedAttempt): RerunJudgement {
  const judged = { ...settled(a), attempt: a.attempt };
  return a.later ? { ...judged, state: "in-flight", later: a.later } : judged;
}

const NEXT: Readonly<Record<Exclude<RerunState, "in-flight" | "real">, string>> = Object.freeze({
  "not-read": "Cause not read yet. Open the run attempt, or ask Copilot to diagnose.",
  retried: "Already retried once. Diagnose the failed jobs.",
  unverdicted: "Failed with no Environment verdict. Open the run attempt to decide.",
  eligible: "Re-run the failed jobs once. If it fails again, diagnose.",
  held: "Re-run the failed jobs once the environment reads deployable.",
});

/** The Next sentence; a real failure takes its class's step and where its fix lands. */
export function rerunNext(j: RerunJudgement, step: string, lands: string): string {
  if (j.state === "in-flight") {
    return `Re-run in flight (attempt ${j.later}). If it fails again, diagnose the failed jobs.`;
  }
  if (j.state === "real") return `${step}, then fix it on ${lands}.`;
  return NEXT[j.state];
}
