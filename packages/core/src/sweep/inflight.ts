// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { declarationPath, pollRun } from "../collect/lifecycle.js";
import { readTemplateRuns } from "../collect/runs.js";
import { LIFECYCLE_WORKFLOWS, type LifecycleKind } from "../config.js";
import type { CoreContext } from "../context.js";
import type { ReadRecord } from "../evidence/index.js";
import type { Facts, LifecycleRun, RunFact } from "../facts.js";
import { Gh } from "../forge.js";
import type { CollectorCache } from "./cache.js";
import type { SweepInflight, SweepInput } from "./sweeper.js";

const POLLED: readonly LifecycleKind[] = Object.freeze(["refresh", "upgrade"]);

/** What the stack strip draws from a run: its status and each job's and step's state. */
export function progress(run: LifecycleRun): string {
  return JSON.stringify([
    run.status,
    run.conclusion,
    (run.jobs ?? []).map((j) => [
      j.status,
      j.conclusion,
      j.steps.map((s) => [s.status, s.conclusion]),
    ]),
  ]);
}

function syncingForks(facts: Facts, ctx: CoreContext): string[] {
  const runs = facts.runs.data ?? {};
  return ctx.fleet.forks.map((f) => f.repo).filter((repo) =>
    (runs[repo]?.template ?? []).some((r) => r.status !== "completed"));
}

export function hasInflight(facts: Facts, ctx: CoreContext): boolean {
  const lc = facts.lifecycle.data;
  const stack = !!lc && POLLED.some((kind) => (lc[kind] ?? []).some((r) => r.status !== "completed"));
  return stack || syncingForks(facts, ctx).length > 0;
}

const same = (a: ReadRecord, b: ReadRecord) => a.source === b.source && a.object === b.object;

function lastObserved(record: ReadRecord | undefined): string | undefined {
  return record?.retainedFrom ?? (record?.failure === undefined ? record?.observedAt : undefined);
}

// A run's own evidence: its run and job reads. Declaration reads are shared by commit.
function owns(run: LifecycleRun, r: ReadRecord, stack: string): boolean {
  if (r.source !== "github") return false;
  const base = `repos/${stack}/actions/runs/${run.id}`;
  return r.object === base || r.object.startsWith(`${base}/`) || (run.jobs ?? []).some((j) =>
    r.object.startsWith(`repos/${stack}/check-runs/${j.id}/`) ||
    r.object === `repos/${stack}/actions/jobs/${j.id}/logs`);
}

function replaceRun(prior: readonly ReadRecord[], run: LifecycleRun, polled: readonly ReadRecord[], stack: string) {
  return [...prior.filter((r) => !owns(run, r, stack) && !polled.some((p) => same(p, r))), ...polled];
}

function signature(runs: readonly RunFact[]): string {
  return runs.map((r) => `${r.id}:${r.status}`).join();
}

/**
 * Between sweeps, re-read each running refresh or upgrade and each fork's
 * running Sync Template on its own. Every poll leaves its own read records;
 * a failed poll keeps the last state beside its failure.
 */
export async function pollInflight(
  input: SweepInput<CollectorCache>,
): Promise<{ changed: boolean; settled: boolean }> {
  const { ctx, facts, cache, reads } = input;
  const gh = new Gh(input.exec);
  let changed = false;
  let settled = false;
  for (const repo of syncingForks(facts, ctx)) {
    const entry = facts.runs.data?.[repo];
    if (!entry) continue;
    const result = await readTemplateRuns(gh, repo, ctx);
    const prior = reads.runs ?? [];
    const others = prior.filter((r) => !(r.source === repo && r.object === "template-runs"));
    if (result.reads.some((r) => r.failure)) {
      const last = prior.find((r) => r.source === repo && r.object === "template-runs") ??
        prior.find((r) => r.source === repo && r.object === "fork-runs");
      const retainedFrom = lastObserved(last);
      reads.runs = [...others, ...result.reads.map((r) => ({ ...r, ...(retainedFrom ? { retainedFrom } : {}) }))];
      continue;
    }
    const before = signature(entry.template);
    entry.template = result.data;
    reads.runs = [...others, ...result.reads];
    if (signature(result.data) !== before) changed = true;
    if (!syncingForks(facts, ctx).includes(repo)) settled = true;
  }
  const lc = facts.lifecycle.data;
  for (const kind of POLLED) {
    const runs = lc?.[kind] ?? [];
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!run || run.status === "completed") continue;
      const prior = reads.lifecycle ?? [];
      const own = prior.filter((r) => owns(run, r, ctx.stackRepo) ||
        (r.source === "github" && r.object === declarationPath(run.sha, ctx)));
      const result = await pollRun(gh, cache.details, { data: run, reads: own }, ctx);
      cache.details = result.cache;
      const polled = result.reads.map((r) => {
        if (!r.failure || r.retainedFrom || r.object !== `repos/${ctx.stackRepo}/actions/runs/${run.id}`) return r;
        // A run first seen in its workflow listing was last observed by that listing.
        const listing = prior.find((p) => p.source === "github" &&
          p.object.startsWith(`repos/${ctx.stackRepo}/actions/workflows/${LIFECYCLE_WORKFLOWS[kind]}/runs?`));
        const retainedFrom = lastObserved(listing);
        return retainedFrom ? { ...r, retainedFrom } : r;
      });
      reads.lifecycle = replaceRun(prior, run, polled, ctx.stackRepo);
      const kept = cache.lifecycle.lifecycle?.[kind];
      if (kept) {
        kept.data = kept.data.map((r) => (r.id === run.id ? result.data : r));
        kept.reads = replaceRun(kept.reads, run, polled, ctx.stackRepo);
      }
      if (progress(result.data) !== progress(run)) changed = true;
      runs[i] = result.data;
      if (result.data.status === "completed") settled = true;
    }
  }
  return { changed, settled };
}

export const collectorInflight: SweepInflight<CollectorCache> = Object.freeze({
  has: hasInflight,
  poll: pollInflight,
});
