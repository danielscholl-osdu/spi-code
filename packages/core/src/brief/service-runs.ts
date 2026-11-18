// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RunFact } from "../facts.js";
import { workflowRunFailed } from "../model/workflow-failure.js";
import { readRunHistory, type ServiceRun, type ServiceRunsFact, workflowGroups, workflowPath } from "../service-runs.js";

const WORK_STATES: ReadonlySet<string> = new Set(["in_progress", "queued", "waiting", "pending"]);

function byStart(a: ServiceRun, b: ServiceRun) {
  return Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt) ||
    a.id - b.id || a.attempt - b.attempt;
}

function displayRun<T extends Pick<ServiceRun, "status" | "conclusion">>(run: T) {
  const result = run.status === "completed" ? run.conclusion || run.status : run.status;
  const tone = workflowRunFailed(run) ? "error" : result === "success" ? "success"
    : WORK_STATES.has(result) ? "work" : "neutral";
  return { ...run, result, tone } as const;
}

export function serviceRuns(fact: ServiceRunsFact | undefined, mainRun?: RunFact) {
  const history = readRunHistory(fact);
  if (!history) return { kind: "unread", count: null } as const;
  const { cut, failures, runs } = history;
  const known = [...runs, ...failures.map(({ run }) => run)];
  const mainPath = workflowPath(mainRun?.path);
  const mainWorkflowId = mainRun && (known.find(({ id }) => id === mainRun.id) ??
    (mainPath ? known.find(({ path }) => workflowPath(path) === mainPath) : undefined))?.workflowId;
  const failingIds = new Set(failures.map(({ run }) => run.workflowId));
  if (mainWorkflowId !== undefined) failingIds.add(mainWorkflowId);
  const workflows = workflowGroups(runs).flatMap((group) => {
    const sorted = group.sort(byStart);
    const newest = sorted.at(-1);
    if (!newest) return [];
    const path = sorted.filter((run) => run.path).at(-1)?.path;
    const rank = failingIds.has(newest.workflowId) ? 0 : path?.startsWith("dynamic/") ? 2 : 1;
    return [{ id: newest.workflowId, name: newest.name, runs: sorted.map(displayRun), rank }];
  }).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.id - b.id)
    .map(({ rank, ...workflow }) => rank === 2 ? { ...workflow, automation: true as const } : workflow);
  const main = mainRun && { id: mainRun.id, attempt: mainRun.attempt, url: mainRun.url, failedAt: mainRun.updatedAt };
  const failing = failures.map(({ run, ...cause }) => ({
    ...cause,
    run: displayRun(run),
    ...(main && run.workflowId === mainWorkflowId ? { main } : {}),
  }));
  const mainOnly = main && mainRun && !failing.some((entry) => entry.main) ? [{
    run: displayRun({
      id: mainRun.id,
      name: mainRun.name,
      attempt: mainRun.attempt,
      status: mainRun.status,
      conclusion: mainRun.conclusion,
      createdAt: mainRun.createdAt,
      url: mainRun.url,
    }),
    main,
  }] : [];
  const entries = [...failing, ...mainOnly].sort((a, b) =>
    a.run.name.localeCompare(b.run.name) || a.run.id - b.run.id);
  return { kind: "read", count: entries.length, cut, workflows, failing: entries } as const;
}
