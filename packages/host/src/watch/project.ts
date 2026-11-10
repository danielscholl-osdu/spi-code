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
  type Facts,
  type FocusItem,
  formingReleases,
  isMonth,
  monthFacts,
  parseNotes,
  RELEASES_EVERY_MS,
  type ReadRecord,
  type ReleaseBody,
  type ReleaseReads,
  releaseDoc,
  releaseLine,
  releaseMonths,
  releasesToday,
  STACK_REPO,
  type SweepReads,
} from "@spi-code/core";
import { type AttentionInput, itemAttention } from "./attention.js";
import { detectedCampaigns } from "./campaigns.js";
import {
  areaEnvelopes,
  briefingProvenance,
  readEnvelope,
  releaseProvenance,
  stationProvenance,
} from "./provenance.js";
import { placeReadings } from "./readings.js";
import { recordedRuns, runProvenance } from "./recorded-runs.js";
import { repositoryLines } from "./repository-lines.js";
import { type SeenBaseline, seenState } from "./seen.js";
import { serviceReleaseReadTimes } from "./service-release-reads.js";
import { stationSubstate } from "./substate.js";

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

export function readNotes(appData: string, month: string) {
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
  readonly releases: ReleaseReads & { readonly bodies?: Readonly<Record<string, ReleaseBody>> };
  readonly reads: SweepReads;
  readonly releaseRecords: readonly ReadRecord[];
  readonly doctor: DoctorView;
  readonly context: CoreContext;
  readonly appData: string;
  readonly cursor: number;
  readonly intervalMs: number;
  readonly baseline?: SeenBaseline;
  readonly attention?: AttentionInput;
  /** Per-area sweep intervals; an area without one uses intervalMs. */
  readonly intervals?: Partial<Record<AreaName, number>>;
  /** Confirmed immutable cache reads for envelopes; reads retains the original observations. */
  readonly envelopeReads?: SweepReads;
  readonly readIntervals?: ReadonlyMap<ReadRecord, number>;
  readonly selection?: string | null;
  readonly reading?: boolean;
}

function treeOf(input: WatchInput, now: Date): TreeStatus {
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

/** Builds data only. The router owns posting this validated value. */
export function projectWatch(input: WatchInput): ViewSnapshot {
  const now = input.context.clock.now();
  const model = buildModel(input.facts, now, {}, input.context);
  const coreBriefing = buildBriefing(model, input.doctor, now, input.context);
  const projectItem = (item: FocusItem) => ({
    ...item,
    ...itemAttention(item, model, input, input.attention),
  });
  const briefing = {
    ...coreBriefing,
    focus: coreBriefing.focus.map(projectItem),
    rest: coreBriefing.rest.map(projectItem),
    repositories: repositoryLines(coreBriefing.repositories, model, now),
  };
  const { pane: releases, documents } = projectReleases(
    input.releases,
    input.appData,
    now,
    input.context,
    input.reading,
  );
  const runs = recordedRuns(input.facts, input.context.stackRepo);
  const stations = model.lines.map((line) => ({
    service: line.fork.id,
    stations: line.stations.map((station) => ({
      ...station,
      substate: stationSubstate(station, line, input),
      inspect: `station:${line.fork.id}:${station.id}`,
    })),
  }));
  const services = model.lines.map((line) => ({
    service: line.fork.id,
    runs: runs
      .filter(({ repo }) => repo === line.fork.repo)
      .sort(
        (a, b) => Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt) || b.run.id - a.run.id,
      )
      .map(({ run }) => ({
        id: `run:${run.id}`,
        workflow: run.name,
        result: run.status === "completed" ? (run.conclusion ?? "completed") : run.status,
        time: run.createdAt,
        url: run.url,
      })),
    releases: documents.flatMap((doc) =>
      doc.rows
        .filter((row) => row.id === line.fork.id)
        .map((row) => {
          const gate = line.stations.find((station) => station.id === "release");
          const pr = line.releasePr?.pr;
          return {
            ...row,
            month: doc.month,
            readTimes: serviceReleaseReadTimes(line.fork.repo, input),
            ...(doc.month === now.toISOString().slice(0, 7)
              ? {
                  ...(gate ? { gate: { state: gate.state, text: gate.text } } : {}),
                  ...(pr ? { releasePr: { number: pr.number, title: pr.title, url: pr.url } } : {}),
                }
              : {}),
          };
        }),
    ),
  }));
  const campaigns = detectedCampaigns(model, input);
  releases.today = releasesToday({
    services,
    documents,
    facts: input.facts,
    context: input.context,
    provenance: releaseProvenance(releases.lines, input.releaseRecords, now),
  });
  return ViewSnapshotSchema.parse({
    cursor: input.cursor,
    sweptAt: model.sweptAt ?? now.toISOString(),
    briefing,
    campaigns,
    readings: placeReadings(model, input, briefing, documents, campaigns),
    seen: seenState(model, input, briefing),
    releases: {
      ...releases,
      forming: formingReleases({
        ...(input.releases.bodies ? { bodies: input.releases.bodies } : {}),
        ...(input.facts.github.data ? { open: input.facts.github.data.repos } : {}),
        context: input.context,
      }),
    },
    stations,
    services,
    tree: treeOf(input, now),
    reads: [...Object.values(input.reads).flat(), ...input.releaseRecords],
    areas: areaEnvelopes(
      input.envelopeReads ?? input.reads,
      (area, record) =>
        input.readIntervals?.get(record) ?? input.intervals?.[area] ?? input.intervalMs,
      now,
    ),
    provenance: [
      ...briefingProvenance(briefing, model.stack),
      ...stationProvenance(stations),
      ...releaseProvenance(releases.lines, input.releaseRecords, now),
      ...services.flatMap((service, i) => [
        ...runProvenance(
          `/services/${i}/runs`,
          service.runs,
          runs,
          model.lines[i]?.fork.repo ?? "",
        ),
        {
          path: `/services/${i}/releases`,
          areas: ["fleet", "github"],
          envelope: readEnvelope("releases", input.releaseRecords, RELEASES_EVERY_MS, now),
        },
      ]),
    ],
    selection: input.selection ?? null,
  });
}
