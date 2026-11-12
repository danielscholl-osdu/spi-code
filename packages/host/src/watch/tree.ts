// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { TreeStatus } from "@spi-code/contracts";
import {
  AREAS,
  type AreaName,
  RELEASES_EVERY_MS,
  type ReadRecord,
  STACK_REPO,
} from "@spi-code/core";
import type { WatchInput } from "./project.js";
import { readEnvelope } from "./provenance.js";

export function treeOf(input: WatchInput, now: Date): TreeStatus {
  const evidence = input.envelopeReads ?? input.reads;
  const records = (areas: readonly AreaName[]) => areas.flatMap((area) => evidence[area] ?? []);
  const intervalOf = new Map<ReadRecord, number>();
  for (const area of AREAS) {
    const interval = input.intervals?.[area] ?? input.intervalMs;
    for (const record of evidence[area] ?? []) {
      if (!intervalOf.has(record)) {
        intervalOf.set(record, input.readIntervals?.get(record) ?? interval);
      }
    }
  }
  for (const record of input.releaseRecords) intervalOf.set(record, RELEASES_EVERY_MS);
  const stateOf = (reads: readonly ReadRecord[]) =>
    readEnvelope("tree", reads, (record) => intervalOf.get(record) ?? input.intervalMs, now).state;
  const node = (id: string, reads: readonly ReadRecord[]) => ({ id, status: stateOf(reads) });
  const all = [...Object.values(evidence).flat(), ...input.releaseRecords];
  const environment = records(["github", "lifecycle"]);
  const services = records(["github", "runs", "upstream", "radar", "template"]);
  const sharedTemplateReads = records(["template"]).filter((record) => {
    const state = stateOf([record]);
    return state === "failed" || state === "incomplete" || state === "stale";
  });
  const areaFailures = (["github", "runs", "upstream", "radar"] as const).flatMap((area) =>
    (evidence[area] ?? []).filter(
      (r) => r.failure !== undefined && r.source === area && r.object === area,
    ),
  );
  const recordsForRepo = (area: AreaName, repo: string) =>
    records([area]).filter(
      (r) =>
        r.source === repo ||
        r.object.startsWith(`repos/${repo}/`) ||
        (r.source === area && r.object === area),
    );
  const runs = new Map<number, readonly ReadRecord[]>();
  for (const [repo, workflows] of Object.entries(input.facts.runs.data ?? {})) {
    for (const run of [
      workflows.sync,
      workflows.template,
      workflows.cascade,
      workflows.main,
    ].flat()) {
      runs.set(run.id, recordsForRepo("runs", repo));
    }
  }
  for (const list of Object.values(input.facts.lifecycle.data ?? {})) {
    for (const run of list) {
      const repo =
        /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\//.exec(run.url)?.[1] ?? STACK_REPO;
      runs.set(run.id, recordsForRepo("lifecycle", repo));
    }
  }
  for (const [repo, list] of Object.entries(input.facts.approvals.data ?? {})) {
    for (const run of list) runs.set(run.id, recordsForRepo("approvals", repo));
  }
  return [
    node("today", all),
    node("system", [...records(["github", "template", "security"]), ...input.releaseRecords]),
    node("template", records(["github", "template"])),
    node("repositories", records(["github", "security"])),
    node("releases", input.releaseRecords),
    node("stack", environment),
    node("environment", environment),
    node("services", services),
    node("flow", services),
    node("horizon", records(["radar", "upstream"])),
    ...input.context.fleet.forks.map((fork) => {
      const own = [
        ...services.filter(
          (r) =>
            r.source === fork.repo ||
            r.source === fork.upstream ||
            r.object === fork.repo ||
            r.object === fork.id,
        ),
        ...areaFailures,
      ];
      return node(`service:${fork.id}`, own.length === 0 ? [] : [...own, ...sharedTemplateReads]);
    }),
    node("threads", []),
    node("runs", records(["runs", "lifecycle", "approvals"])),
    ...[...runs].map(([id, reads]) => node(`run:${id}`, reads)),
    node("setup", records(["auth"])),
  ];
}
