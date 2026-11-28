// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import {
  type AreaName,
  buildModel,
  type CoreContext,
  type DoctorView,
  type Facts,
  forkReads,
  formingReleases,
  platformReleased,
  type ReadRecord,
  type ReleaseBody,
  type ReleaseReads,
  type SweepReads,
  todayFleet,
} from "@spi-code/core";
import type { AttentionInput } from "./attention.js";
import { projectBriefing, settleBriefing } from "./briefing.js";
import { detectedCampaigns } from "./campaigns.js";
import { areaEnvelopes } from "./provenance.js";
import { placeReadings, securityPlaceReading } from "./readings.js";
import { recordedRuns } from "./recorded-runs.js";
import { projectReleases } from "./releases.js";
import { projectSecurity } from "./security.js";
import { type SeenBaseline, seenState } from "./seen.js";
import { projectServices, projectStations } from "./services.js";
import { snapshotProvenance } from "./snapshot-provenance.js";
import { treeOf } from "./tree.js";

export { appActions } from "./actions.js";
export { projectReleases, readNotes } from "./releases.js";

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

/** Builds data only. The router owns posting this validated value. */
export function projectWatch(input: WatchInput): ViewSnapshot {
  const now = input.context.clock.now();
  const model = buildModel(input.facts, now, { reads: input.reads }, input.context);
  const { briefing, horizon } = projectBriefing(model, input, now);
  const { pane: releases, documents } = projectReleases(
    input.releases,
    input.appData,
    now,
    input.context,
    input.reading,
  );
  const runs = recordedRuns(input.facts, input.context.stackRepo);
  const stations = projectStations(model, input);
  const campaigns = detectedCampaigns(model, input);
  const { services, releases: today } = projectServices(
    model,
    input,
    runs,
    documents,
    now,
    briefing,
    releases,
  );
  briefing.today.fleet = todayFleet(
    services,
    briefing.environment,
    briefing.nextSyncAt,
    briefing.today.causes,
    briefing.lines,
    {
      upstream: model.upstream.forks,
      deployments: model.forkDeployments,
      sources: model.lines.map((line) => ({
        service: line.fork.id,
        ...forkReads(input.facts, input.reads, line),
      })),
      rollout: model.rollout,
    },
  );
  releases.today = today;
  const platform = platformReleased(documents, input.facts, input.context);
  const readings = placeReadings(model, input, briefing, documents, campaigns);
  const areas = areaEnvelopes(
    input.envelopeReads ?? input.reads,
    (area, record) =>
      input.readIntervals?.get(record) ?? input.intervals?.[area] ?? input.intervalMs,
    now,
  );
  const places = settleBriefing(
    briefing,
    horizon,
    model,
    input,
    [...readings, securityPlaceReading(model, input, briefing, campaigns)],
    areas,
    now,
  );
  return ViewSnapshotSchema.parse({
    cursor: input.cursor,
    sweptAt: model.sweptAt ?? now.toISOString(),
    briefing,
    campaigns,
    readings,
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
    security: projectSecurity(model, input, now),
    tree: treeOf(input, now),
    reads: [
      ...Object.values(input.reads).flat(),
      ...input.releaseRecords,
      ...Object.values(input.facts.serviceRuns ?? {}).flatMap(({ read, workflowReads, jobs }) => [
        read,
        ...(workflowReads ?? []),
        ...jobs,
      ]),
    ],
    areas,
    provenance: snapshotProvenance(input, model, now, {
      briefing,
      places,
      stations,
      releases,
      platform,
      services,
      runs,
    }),
    selection: input.selection ?? null,
  });
}
