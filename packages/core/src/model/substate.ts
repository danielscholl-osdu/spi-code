// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Facts, PrFact, RunFact, WaitingRun } from "../facts.js";
import { failedChecks, pendingChecks, prVerdict } from "./checks.js";
import type { LineModel, Station } from "./lines.js";
import { predict } from "./radar.js";

export type StationSubstate =
  | "stopped"
  | "waiting-on-person"
  | "waiting-on-clock"
  | "in-progress"
  | "ready";

type SubstateFacts = Pick<Facts, "approvals" | "runs" | "radar">;

function prNeedsApproval(pr: PrFact, approvals: readonly WaitingRun[]): boolean {
  return approvals.some(
    (run) =>
      run.pr !== null &&
      run.sha === pr.headSha &&
      (run.pr === undefined || run.pr.number === pr.number),
  );
}

function prSubstate(
  pr: PrFact,
  approvals: readonly WaitingRun[],
  autoMerge = false,
): StationSubstate {
  const failed = failedChecks(pr);
  if (
    pr.mergeState === "DIRTY" ||
    failed.some((check) => check.conclusion !== "ACTION_REQUIRED")
  ) {
    return "stopped";
  }
  if (
    failed.some((check) => check.conclusion === "ACTION_REQUIRED") ||
    prNeedsApproval(pr, approvals)
  ) {
    return "waiting-on-person";
  }
  const verdict = prVerdict(pr);
  if (
    pr.draft ||
    pr.reviewDecision === "REVIEW_REQUIRED" ||
    pr.reviewDecision === "CHANGES_REQUESTED"
  ) {
    return "waiting-on-person";
  }
  if (verdict === "pending") return "in-progress";
  return autoMerge && verdict === "green" && pr.mergeState === "CLEAN"
    ? "in-progress"
    : "waiting-on-person";
}

function runSubstate(
  runs: readonly RunFact[] | undefined,
  approvals: readonly WaitingRun[],
): StationSubstate | undefined {
  const needsApproval = (run: RunFact) =>
    approvals.some(
      (waiting) => waiting.pr !== null && waiting.id === run.id && waiting.sha === run.sha,
    );
  const latest = runs?.[0];
  const run =
    runs?.find((run) => run.status !== "completed" || needsApproval(run)) ??
    (latest?.conclusion === "action_required" ? latest : undefined);
  if (!run) return undefined;
  return run.status === "waiting" ||
    run.status === "action_required" ||
    run.conclusion === "action_required" ||
    needsApproval(run)
    ? "waiting-on-person"
    : "in-progress";
}

export function stationSubstateOf(
  station: Station,
  line: LineModel,
  facts: SubstateFacts,
): StationSubstate {
  const approvals = facts.approvals.data?.[line.fork.repo] ?? [];
  const runs = facts.runs.data?.[line.fork.repo];
  const fallback =
    station.state === "stopped"
      ? "stopped"
      : station.state === "moving"
        ? "in-progress"
        : "ready";
  switch (station.id) {
    case "upstream": {
      if (station.state === "stopped" || station.state === "moving") return fallback;
      if (!line.upstream?.lag) return "ready";
      if (line.halt) return "stopped";
      const radar = facts.radar.data;
      const prediction = predict(radar?.services[line.fork.id], radar?.filters[line.fork.id]);
      if (
        prediction?.certain.some(
          (verdict) =>
            verdict.bucket === "Halt" ||
            (verdict.bucket === "Toolchain" && verdict.value?.includes("SNAPSHOT")),
        )
      ) {
        return "waiting-on-person";
      }
      return "waiting-on-clock";
    }
    case "sync":
      if (line.halt) return "stopped";
      return (
        runSubstate(runs?.sync, approvals) ??
        (line.syncPr ? prSubstate(line.syncPr.pr, approvals) : fallback)
      );
    case "cascade":
      if (line.cascadeStop) return "stopped";
      return (
        runSubstate(runs?.cascade, approvals) ??
        (station.state === "waiting" ? "waiting-on-person" : fallback)
      );
    case "main":
      if (line.cascadePr) return prSubstate(line.cascadePr.pr, approvals, line.autoMerge);
      return runSubstate(runs?.main, approvals) ?? fallback;
    case "release":
      return line.releasePr ? prSubstate(line.releasePr.pr, approvals) : fallback;
    case "lane": {
      if (station.state === "stopped") return "stopped";
      const validating = line.prs
        .map(({ pr }) => ({
          pr,
          checks: pendingChecks(pr).filter((check) => check.workflow === "Validation"),
        }))
        .filter(({ checks }) => checks.length > 0);
      if (
        validating.some(
          ({ pr, checks }) =>
            checks.some((check) => check.status === "WAITING") || prNeedsApproval(pr, approvals),
        )
      ) {
        return "waiting-on-person";
      }
      if (validating.length > 0) return "in-progress";
      return (
        runSubstate(runs?.main, approvals) ??
        (station.state === "waiting" ? "stopped" : fallback)
      );
    }
  }
}
