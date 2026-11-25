// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { RunFact } from "../facts.js";
import type { MainFailure } from "../model/lines.js";
import { runFailedAt, workflowRunFailed } from "../model/workflow-failure.js";
import { readRunHistory, type ServiceRun, type ServiceRunsFact, workflowGroups, workflowPath } from "../service-runs.js";

const WORK_STATES: ReadonlySet<string> = new Set(["in_progress", "queued", "waiting", "pending"]);
const MAIN = "main";

const startOf = (run: Pick<ServiceRun, "startedAt" | "createdAt">) => Date.parse(run.startedAt ?? run.createdAt);

function attemptsInOrder(group: ServiceRun[]) {
  const first = new Map<number, number>();
  for (const run of group) first.set(run.id, Math.min(first.get(run.id) ?? Infinity, startOf(run)));
  const key = (run: ServiceRun) => first.get(run.id) ?? startOf(run);
  return group.sort((a, b) => key(a) - key(b) || a.id - b.id || a.attempt - b.attempt);
}

const decisive = (run: ServiceRun) =>
  run.status === "completed" && (run.conclusion === "success" || workflowRunFailed(run));

function displayRun<T extends Pick<ServiceRun, "status" | "conclusion">>(run: T) {
  const result = run.status === "completed" ? run.conclusion || run.status : run.status;
  const tone = workflowRunFailed(run) ? "error" : result === "success" ? "success"
    : WORK_STATES.has(result) ? "work" : "neutral";
  return { ...run, result, tone } as const;
}

function stripLabel(runs: readonly ServiceRun[]) {
  const run = runs.filter((entry) => entry.branch === MAIN && decisive(entry)).at(-1) ??
    runs.filter(decisive).at(-1) ?? runs.at(-1);
  if (!run) return undefined;
  const { result, tone } = displayRun(run);
  const at = decisive(run) ? run.updatedAt ?? run.startedAt ?? run.createdAt : run.startedAt ?? run.createdAt;
  return { result, tone, at, ...(run.branch ? { branch: run.branch } : {}) };
}

export function serviceRuns(fact: ServiceRunsFact | undefined, mainRed?: Pick<MainFailure, "run" | "job">) {
  const history = readRunHistory(fact);
  if (!history) return { kind: "unread", count: null } as const;
  const mainRun: RunFact | undefined = mainRed?.run;
  const { cut, failures, runs } = history;
  const known = [...runs, ...failures.map(({ run }) => run)];
  const mainPath = workflowPath(mainRun?.path);
  const mainWorkflowId = mainRun && (known.find(({ id }) => id === mainRun.id) ??
    (mainPath ? known.find(({ path }) => workflowPath(path) === mainPath) : undefined))?.workflowId;
  const failingIds = new Set(failures.map(({ run }) => run.workflowId));
  if (mainWorkflowId !== undefined) failingIds.add(mainWorkflowId);
  const onPage = new Set(runs.map(({ id }) => id));
  const listed = new Set(runs.map(({ id, attempt }) => `${id}#${attempt}`));
  const earlierAttempts = failures.map(({ run }) => run)
    .filter(({ id, attempt }) => onPage.has(id) && !listed.has(`${id}#${attempt}`));
  const workflows = workflowGroups([...runs, ...earlierAttempts]).flatMap((group) => {
    const sorted = attemptsInOrder(group);
    const newest = sorted.at(-1);
    const label = stripLabel(sorted);
    if (!newest || !label) return [];
    const path = sorted.filter((run) => run.path).at(-1)?.path;
    const rank = failingIds.has(newest.workflowId) ? 0 : path?.startsWith("dynamic/") ? 2 : 1;
    return [{ id: newest.workflowId, name: newest.name, runs: sorted.map(displayRun), label, rank }];
  }).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name) || a.id - b.id)
    .map(({ rank, ...workflow }) => rank === 2 ? { ...workflow, automation: true as const } : workflow);
  const main = mainRun &&
    { id: mainRun.id, attempt: mainRun.attempt, url: mainRun.url, failedAt: runFailedAt(mainRun) };
  const mainJob = mainRed?.job && {
    job: mainRed.job.name,
    ...(mainRed.job.failedStep ? { step: mainRed.job.failedStep } : {}),
  };
  const isMain = (run: Pick<ServiceRun, "id" | "attempt">) => main?.id === run.id && main.attempt === run.attempt;
  const failing = failures.map(({ run, ...cause }) => ({
    ...(isMain(run) && !cause.job ? { ...cause, ...mainJob } : cause),
    run: displayRun(run),
    ...(main && run.workflowId === mainWorkflowId ? { main } : {}),
  }));
  const mainOnly = main && mainRun && !failing.some((entry) => entry.main) ? [{
    ...mainJob,
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
