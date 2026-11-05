// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { jobsKey, jobSchema, lifecycleStateSchema } from "../collect/lifecycle.js";
import { ledgerSchema } from "../collect/ledgers.js";
import { pinStateSchema } from "../collect/pins.js";
import { emptyRadarState, pruneRadar } from "../collect/radar.js";
import { emptyReads, releaseStateSchema } from "../collect/releases.js";
import { prFilesSchema } from "../collect/runs.js";
import { templateStateSchema } from "../collect/template.js";
import type { Facts } from "../facts.js";
import { readRecordSchema } from "./record.js";

const diff = z.object({
  paths: z.array(z.string()), hunks: z.record(z.string(), z.array(z.string())).optional(),
  deleted: z.array(z.string()).optional(),
});
export const cacheSchema = z.object({
  details: z.record(z.string(), z.object({ data: jobSchema, reads: z.array(readRecordSchema).min(1) })),
  lifecycle: lifecycleStateSchema,
  template: templateStateSchema,
  upstream: z.record(z.string(), z.array(z.object({
    sha: z.string(), title: z.string(), at: z.string(), url: z.string(),
  }))),
  approvals: z.record(z.string(), prFilesSchema),
  radar: z.object({
    mrDiffs: z.record(z.string(), diff), commitDiffs: z.record(z.string(), diff),
    filters: z.record(z.string(), z.string()), ledgers: ledgerSchema, pins: pinStateSchema,
    records: z.record(z.string(), readRecordSchema),
  }),
  releases: releaseStateSchema,
  history: z.array(z.object({ area: z.string(), cost: z.number().nonnegative() })),
  budget: z.object({
    cost: z.number().nonnegative(), remaining: z.number().nonnegative().nullable(),
    resetAt: z.iso.datetime({ offset: true }).nullable(), calls: z.int().nonnegative(),
    deferred: z.array(z.object({ area: z.string(), reason: z.string() })),
  }),
});
export type CollectorCache = z.infer<typeof cacheSchema>;
export type SweepBudget = CollectorCache["budget"];

export function emptyCache(): CollectorCache {
  return {
    details: {}, lifecycle: { runJobs: {}, files: {} }, template: {}, upstream: {},
    approvals: {}, radar: emptyRadarState(), releases: emptyReads(), history: [],
    budget: { cost: 0, remaining: null, resetAt: null, calls: 0, deferred: [] },
  };
}

export function pruneCache(facts: Facts, cache: CollectorCache): void {
  const details = new Set(Object.keys(facts.details.data ?? {}));
  const runs = new Set<string>();
  const files = new Set<string>();
  for (const list of Object.values(facts.lifecycle.data ?? {})) {
    for (const run of list) {
      runs.add(jobsKey(run));
      files.add(run.sha);
      for (const job of run.jobs ?? []) details.add(`Azure/osdu-spi-stack#${job.id}`);
    }
  }
  for (const [repo, entry] of Object.entries(facts.runs.data ?? {})) {
    for (const run of [...entry.main, ...entry.cascade]) {
      if (entry.mainRunJobs?.[run.id] || entry.cascadeRunJobs?.[run.id]) runs.add(jobsKey(run));
    }
    for (const jobs of [...Object.values(entry.mainRunJobs ?? {}), ...Object.values(entry.cascadeRunJobs ?? {})])
      for (const job of jobs) details.add(`${repo}#${job.id}`);
  }
  for (const key of Object.keys(cache.details)) if (!details.has(key)) delete cache.details[key];
  for (const key of Object.keys(cache.lifecycle.runJobs)) if (!runs.has(key)) delete cache.lifecycle.runJobs[key];
  for (const key of Object.keys(cache.lifecycle.files)) if (!files.has(key)) delete cache.lifecycle.files[key];
  pruneRadar(cache.radar, facts.radar.data);
  const waiting = new Set(Object.entries(facts.approvals.data ?? {}).flatMap(([repo, list]) =>
    list.flatMap((r) => r.pr ? [`${repo}#${r.pr.number}@${r.pr.headSha}`] : [])));
  for (const key of Object.keys(cache.approvals)) if (!waiting.has(key)) delete cache.approvals[key];
  for (const map of [cache.template, cache.upstream]) {
    for (const key of Object.keys(map).slice(0, Math.max(0, Object.keys(map).length - 40))) delete map[key];
  }
}
