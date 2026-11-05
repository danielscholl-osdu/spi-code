// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActionItemSchema,
  type ActionItem as AppAction,
  ReleaseDocSchema,
  ReleasesPaneSchema,
  type TreeStatus,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import {
  type ActionItem,
  AREAS,
  type AreaName,
  buildBriefing,
  buildModel,
  type CoreContext,
  type DoctorView,
  type EvidenceState,
  envelopeOf,
  type Facts,
  isMonth,
  monthFacts,
  parseNotes,
  type ReadRecord,
  type ReleaseReads,
  releaseDoc,
  releaseLine,
  releaseMonths,
  STACK_REPO,
  type SweepReads,
} from "@spi-code/core";
import {
  areaEnvelopes,
  briefingProvenance,
  releaseProvenance,
  stationProvenance,
} from "./provenance.js";

export function appActions(items: readonly ActionItem[]): AppAction[] {
  const reserved = new Set(items.map((item) => item.type));
  const assigned = new Set<string>();
  return items.map((item) => {
    let id = item.type;
    if (assigned.has(id)) {
      let suffix = 2;
      do {
        id = `${item.type}-${suffix++}`;
      } while (reserved.has(id) || assigned.has(id));
    }
    assigned.add(id);
    const pendingError =
      item.pendingLabel !== undefined && item.pendingLabel.length > 40
        ? "pendingLabel exceeds 40 characters"
        : undefined;
    const reason =
      pendingError === undefined
        ? item.reason
        : item.reason === undefined
          ? pendingError
          : `${item.reason}; ${pendingError}`;
    if (item.confirm?.irreversible && !item.confirm.subject?.trim()) {
      throw new TypeError(`${item.type}: irreversible action requires a subject`);
    }
    return ActionItemSchema.parse({
      id,
      label: item.label,
      disabledReason: "writes arrive at M4",
      ...(reason === undefined ? {} : { eligibilityReason: reason }),
    });
  });
}

function readNotes(appData: string, month: string) {
  if (!isMonth(month)) throw new RangeError(`Invalid notes month: ${month}`);
  const path = join(appData, "notes", `${month}.json`);
  let raw: string | undefined;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return parseNotes(path, raw);
}

export function projectReleases(
  reads: ReleaseReads,
  appData: string,
  now: Date,
  context: CoreContext,
  reading = false,
) {
  const documents = releaseMonths(reads, now).map((month) =>
    releaseDoc(monthFacts(reads, month, now, context), readNotes(appData, month), now),
  );
  return {
    documents: documents.map((doc) => ReleaseDocSchema.parse(doc)),
    pane: ReleasesPaneSchema.parse({ lines: documents.map(releaseLine), reading }),
  };
}

export interface WatchInput {
  readonly facts: Facts;
  readonly releases: ReleaseReads;
  readonly reads: SweepReads;
  readonly releaseRecords: readonly ReadRecord[];
  readonly doctor: DoctorView;
  readonly context: CoreContext;
  readonly appData: string;
  readonly cursor: number;
  readonly intervalMs: number;
  /** Per-area sweep intervals; an area without one uses intervalMs. */
  readonly intervals?: Partial<Record<AreaName, number>>;
  readonly selection?: string | null;
  readonly reading?: boolean;
}

const SEVERITY = { unread: 0, fresh: 1, stale: 2, incomplete: 3, failed: 4 } as const;

function treeOf(input: WatchInput, now: Date): TreeStatus {
  const records = (areas: readonly AreaName[]) => areas.flatMap((area) => input.reads[area] ?? []);
  const intervalOf = new Map<ReadRecord, number>();
  for (const area of AREAS) {
    const interval = input.intervals?.[area] ?? input.intervalMs;
    for (const record of input.reads[area] ?? []) {
      if (!intervalOf.has(record)) intervalOf.set(record, interval);
    }
  }
  const stateOf = (reads: readonly ReadRecord[]): EvidenceState => {
    const groups = new Map<number, ReadRecord[]>();
    for (const record of reads) {
      const interval = intervalOf.get(record) ?? input.intervalMs;
      groups.set(interval, [...(groups.get(interval) ?? []), record]);
    }
    let worst: EvidenceState = "unread";
    for (const [intervalMs, group] of groups) {
      const { state } = envelopeOf(group, { intervalMs, now: now.getTime() });
      if (SEVERITY[state] > SEVERITY[worst]) worst = state;
    }
    return worst;
  };
  const node = (id: string, reads: readonly ReadRecord[]) => ({ id, status: stateOf(reads) });
  const all = [...Object.values(input.reads).flat(), ...input.releaseRecords];
  const environment = records(["github", "lifecycle"]);
  const services = records(["github", "runs", "upstream", "radar", "template"]);
  const sharedTemplateReads = records(["template"]).filter((record) => {
    const state = stateOf([record]);
    return state === "failed" || state === "stale";
  });
  const areaFailures = (["github", "runs", "upstream", "radar"] as const).flatMap((area) =>
    (input.reads[area] ?? []).filter(
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

/** Builds data only. The router owns posting this validated value. */
export function projectWatch(input: WatchInput): ViewSnapshot {
  const now = input.context.clock.now();
  const model = buildModel(input.facts, now, {}, input.context);
  const briefing = buildBriefing(model, input.doctor, now, input.context);
  const releases = projectReleases(
    input.releases,
    input.appData,
    now,
    input.context,
    input.reading,
  ).pane;
  const stations = model.lines.map((line) => ({ service: line.fork.id, stations: line.stations }));
  return ViewSnapshotSchema.parse({
    cursor: input.cursor,
    sweptAt: model.sweptAt ?? now.toISOString(),
    briefing,
    releases,
    stations,
    tree: treeOf(input, now),
    reads: [...Object.values(input.reads).flat(), ...input.releaseRecords],
    areas: areaEnvelopes(input.reads, (area) => input.intervals?.[area] ?? input.intervalMs, now),
    provenance: [
      ...briefingProvenance(briefing, model.stack),
      ...stationProvenance(stations),
      ...releaseProvenance(releases.lines),
    ],
    selection: input.selection ?? null,
  });
}
