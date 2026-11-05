// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  AREAS,
  type AreaName,
  type CollectorCache,
  envelopeOf,
  GITLAB_EVERY_MS,
  type ReadRecord,
  SECURITY_EVERY_MS,
  type SweepState,
} from "@spi-code/core";
import type { WatchInput } from "../watch/project.js";

type Evidence = Pick<WatchInput, "reads" | "envelopeReads" | "intervals" | "readIntervals">;

/** Source observation times stay intact; only envelope evidence can confirm an immutable cache hit. */
export function sweepEvidence(
  { facts, cache, reads }: SweepState<CollectorCache>,
  intervalMs: number,
  now: Date,
): Evidence {
  const intervals = {
    upstream: GITLAB_EVERY_MS,
    radar: GITLAB_EVERY_MS,
    security: SECURITY_EVERY_MS,
  };
  const current = (area: AreaName) => {
    const measured = facts[area];
    return (
      facts.sweep !== undefined &&
      measured.at !== undefined &&
      Date.parse(measured.at) >= Date.parse(facts.sweep.at) &&
      measured.error === undefined &&
      !reads[area]?.some((record) => record.failure !== undefined)
    );
  };
  const key = (record: Pick<ReadRecord, "source" | "object" | "observedAt">) =>
    JSON.stringify([record.source, record.object, record.observedAt]);
  const jobs = [...Object.values(cache.details), ...Object.values(cache.lifecycle.runJobs)].flatMap(
    (entry) => entry.reads,
  );
  const immutable: Partial<Record<AreaName, Set<string>>> = {
    runs: new Set(jobs.map(key)),
    lifecycle: new Set(
      [...jobs, ...Object.values(cache.lifecycle.files).flatMap((entry) => entry.reads)].map(key),
    ),
    details: new Set(
      Object.values(cache.details)
        .flatMap((entry) => entry.reads)
        .map(key),
    ),
    template: new Set(Object.values(cache.template).map((entry) => key(entry.record))),
  };
  const readIntervals = new Map<ReadRecord, number>();
  const envelopeReads = { ...reads };
  const sourceReads = { ...reads };
  for (const area of AREAS) {
    const records = reads[area] ?? [];
    const at = facts[area].at;
    const confirmed =
      current(area) && (!(area === "template" || area === "details") || current("github"));
    envelopeReads[area] = records.map((record) => {
      if (area === "fleet" && record.object === "actions/variables") {
        readIntervals.set(record, GITLAB_EVERY_MS);
      }
      return confirmed &&
        at !== undefined &&
        record.failure === undefined &&
        record.retainedFrom === undefined &&
        record.completeness.kind === "complete" &&
        immutable[area]?.has(key(record))
        ? { ...record, observedAt: at }
        : record;
    });
    const deferred = cache.budget.deferred.find((entry) => entry.area === area);
    if (deferred) {
      const { observedAt: retainedFrom } = envelopeOf(records, {
        intervalMs,
        now: now.getTime(),
      });
      const skipped: ReadRecord = {
        source: area,
        object: area,
        observedAt: now.toISOString(),
        completeness: { kind: "complete" },
        failure: `Read deferred: ${deferred.reason}`,
        ...(retainedFrom === undefined ? {} : { retainedFrom }),
      };
      sourceReads[area] = [...records, skipped];
      envelopeReads[area] = [...records, skipped];
    }
  }
  return { reads: sourceReads, envelopeReads, intervals, readIntervals };
}
