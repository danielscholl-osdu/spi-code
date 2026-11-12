// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type AreaEnvelope, type InspectResult, InspectResultSchema } from "@spi-code/contracts";
import { type Facts, itemClass, type Model, type QueueItem, type RunFact } from "@spi-code/core";
import { type RunHit, recordedRuns } from "../watch/recorded-runs.js";
import { webUrl } from "./shared.js";

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/**
 * A workflow run the sweep read, wherever it was read: a fork lane, the stack, or an approval.
 * The id is matched as text, so only the exact spelling the views hand over resolves.
 */
export function findRun(facts: Facts, key: string, stackRepo: string): RunHit | undefined {
  return recordedRuns(facts, stackRepo).find(({ run }) => String(run.id) === key);
}

/** The queue item that folds this run, as the Environment lanes and lane runs name it. */
export function coveringItem(model: Model, run: RunFact): QueueItem | undefined {
  const stack = model.queue.items.find((item) => item.kind === "stack");
  if (stack && model.stack.attempts.some((a) => a.run.id === run.id)) return stack;
  return model.queue.items.find(
    (item) =>
      item.lanes?.some((lane) => lane.runId === run.id) ||
      item.url === run.url ||
      item.url?.startsWith(`${run.url}/`),
  );
}

export function runResult(
  id: string,
  { run, repo, workflow }: RunHit,
  item: QueueItem | undefined,
  areas: readonly AreaEnvelope[],
): InspectResult {
  const outcome = run.status === "completed" ? (run.conclusion ?? "completed") : run.status;
  return InspectResultSchema.parse({
    id,
    title: `${run.name} #${run.id}`,
    class: item ? itemClass(item) : FAILED.has(run.conclusion ?? "") ? "INCIDENT" : "READY",
    cause: `${run.name} #${run.id} on ${repo}`,
    effect: `${workflow} run ${outcome}`,
    next: item ? item.text : "",
    why: [
      run.event,
      run.branch ? `on ${run.branch}` : undefined,
      run.sha ? `at ${run.sha.slice(0, 7)}` : undefined,
      `attempt ${run.attempt}`,
    ]
      .filter(Boolean)
      .join(" "),
    evidence: [],
    related: [
      { text: run.title || run.name, state: "On GitHub", ...webUrl(run.url) },
      ...(item ? [{ text: item.text, state: "In the queue", inspect: item.id }] : []),
    ],
    approval: null,
    actions: [],
    areas,
    provenance: [],
  });
}
