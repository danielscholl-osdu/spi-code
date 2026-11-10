// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReadRecord } from "../evidence/index.js";
import type { Facts, ForkRuns, RunFact } from "../facts.js";
import { classifyPr } from "../model/attribution.js";
import type { Model } from "../model/index.js";
import type { LineModel } from "../model/lines.js";

export interface SinceSlot {
  service: string;
  state: "empty" | "occupied" | "done" | "waiting" | "broken" | "unknown";
  text: string;
}

export interface SinceRow {
  workflow: string;
  label: string;
  countText: string;
  slots: SinceSlot[];
}

export interface Since {
  basis: "seen" | "fallback" | "history-short" | "stale";
  from: string;
  asOf?: string;
  rows: SinceRow[];
}

const DAY_MS = 86_400_000;
const WORKFLOWS = Object.freeze([
  { workflow: "sync", label: "Sync Upstream" },
  { workflow: "template", label: "Sync Template" },
] as const);
type Workflow = (typeof WORKFLOWS)[number]["workflow"];

function completed(runs: readonly RunFact[], from: number, to: number): RunFact | undefined {
  return runs
    .filter((run) => run.status === "completed" && Date.parse(run.updatedAt) > from && Date.parse(run.updatedAt) <= to)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id - a.id)[0];
}

function slotOf(
  line: LineModel, workflow: Workflow, label: string, run: RunFact | undefined,
  history: ForkRuns | undefined, model: Model, from: number,
): SinceSlot {
  const slot = (state: SinceSlot["state"], text: string): SinceSlot => ({ service: line.fork.id, state, text });
  const subject = `${label} on ${line.fork.id}`;
  if (run?.conclusion === "action_required") {
    return slot("waiting", `${subject} is waiting for approval.`);
  }
  if (run && ["failure", "timed_out", "startup_failure"].includes(run.conclusion ?? "")) {
    return slot("broken", `${label} failed on ${line.fork.id}.`);
  }
  if (workflow === "template") {
    const rollout = model.rollout?.forks.find((fork) => fork.service === line.fork.id);
    if (rollout?.onTarget) return slot("done", `${line.fork.id} has merged ${model.rollout?.target.label}.`);
    if (rollout?.carries && rollout.pr) return slot("occupied", `${subject} has PR #${rollout.pr.number} open for ${model.rollout?.target.label}.`);
  }
  if (run?.conclusion === "success") {
    const pr = workflow === "sync" ? line.syncPr?.pr : line.templatePr?.pr;
    const inRun = (time: string) => Date.parse(time) >= Date.parse(run.createdAt) && Date.parse(time) <= Date.parse(run.updatedAt);
    const past = line.past?.find((p) => classifyPr(p) === workflow && inRun(p.createdAt));
    if (pr && (inRun(pr.createdAt) || inRun(pr.updatedAt))) {
      return slot("occupied", `${subject} brought changes to PR #${pr.number}.`);
    }
    if (past) return slot("occupied", `${subject} brought changes to PR #${past.number}.`);
    return slot("unknown", `${subject} ran, effect unknown.`);
  }
  if (run) return slot("unknown", `${subject} finished ${run.conclusion ?? "with no result"}; effect unknown.`);
  const coverage = history?.history?.[workflow];
  const covered = coverage?.complete || (coverage?.from !== undefined && Date.parse(coverage.from) <= from);
  const nothingWaiting = line.repoRead && (workflow === "sync"
    ? !line.syncPr && line.upstream?.lag === 0
    : !line.templatePr && line.template.behind === 0);
  if (history && covered && nothingWaiting && !history[workflow].some((r) => r.status !== "completed")) {
    return slot("empty", `No ${label} run finished on ${line.fork.id} in this window.`);
  }
  return slot("unknown", `${subject}: no completed run read in this window; effect unknown.`);
}

/** from is a seen baseline when supplied; otherwise the window covers the preceding 24 hours. */
export function sinceOf(
  model: Model, facts: Facts, now: Date, intervalMs: number, from?: string, reads?: readonly ReadRecord[],
): Since | undefined {
  const observations = reads?.filter((read) => read.object === "fork-runs" || read.source === "runs")
    .map((read) => read.retainedFrom ?? (read.failure ? undefined : read.observedAt))
    .filter((time): time is string => time !== undefined);
  const observed = observations?.length ? observations.sort((a, b) => Date.parse(a) - Date.parse(b))[0] : facts.runs.at;
  if (!observed || !facts.runs.data) return undefined;
  const sweptAt = model.sweptAt ?? observed;
  const stale = Date.parse(observed) < Date.parse(sweptAt) || !!facts.runs.error || now.getTime() - Date.parse(sweptAt) > 2 * intervalMs;
  const to = Date.parse(observed);
  let start = stale ? to - DAY_MS : from === undefined ? to - DAY_MS : Date.parse(from);
  let basis: Since["basis"] = stale ? "stale" : from === undefined ? "fallback" : "seen";
  for (const line of model.lines) {
    const history = facts.runs.data[line.fork.repo];
    for (const { workflow } of WORKFLOWS) {
      if (history?.history?.[workflow].complete) continue;
      const oldest = history?.history?.[workflow].from ?? history?.[workflow].map((run) => run.createdAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
      if (oldest && Date.parse(oldest) > start && Date.parse(oldest) <= to) {
        start = Date.parse(oldest);
        if (!stale) basis = "history-short";
      }
    }
  }
  const rows: SinceRow[] = WORKFLOWS.map(({ workflow, label }) => {
    const runs = model.lines.map((line) => completed(facts.runs.data?.[line.fork.repo]?.[workflow] ?? [], start, to));
    const ok = runs.filter((run) => run?.conclusion === "success").length;
    return {
      workflow, label,
      countText: workflow === "template" && model.rollout
        ? `${model.rollout.merged}/${model.rollout.total} merged`
        : `${ok}/${model.lines.length} ran ok`,
      slots: model.lines.map((line, index) => slotOf(line, workflow, label, runs[index], facts.runs.data?.[line.fork.repo], model, start)),
    };
  });
  return { basis, from: new Date(start).toISOString(), ...(stale ? { asOf: observed } : {}), rows };
}
