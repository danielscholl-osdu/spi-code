// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { workflowRunFailed } from "../model/workflow-failure.js";
import { type ServiceRun, type ServiceRunsFact, workflowGroups } from "../service-runs.js";

function byStart(a: ServiceRun, b: ServiceRun) {
  return Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt) ||
    a.id - b.id || a.attempt - b.attempt;
}

function displayRun(run: ServiceRun) {
  const result = run.status === "completed" ? run.conclusion ?? run.status : run.status;
  const tone = workflowRunFailed(run) ? "error" : result === "success" ? "success"
    : result === "in_progress" ? "work" : "neutral";
  return { ...run, result, tone } as const;
}

export function serviceRuns(fact: ServiceRunsFact | undefined) {
  if (!fact?.history || fact.read.failure !== undefined) return { kind: "unread", count: null } as const;
  const { cut, failures, runs } = fact.history;
  const workflows = workflowGroups(runs).flatMap((group) => {
    const sorted = group.sort(byStart);
    const newest = sorted.at(-1);
    if (!newest) return [];
    return [{ id: newest.workflowId, name: newest.name, runs: sorted.map(displayRun) }];
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
  const failing = failures.map(({ run, ...cause }) => ({
    ...cause,
    run: displayRun(run),
  })).sort((a, b) => a.run.name.localeCompare(b.run.name) || a.run.workflowId - b.run.workflowId);
  return { kind: "read", count: failing.length, cut, workflows, failing } as const;
}
