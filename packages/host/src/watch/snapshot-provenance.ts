// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ValueSource } from "@spi-code/contracts";
import { type Model, type platformReleased, RELEASES_EVERY_MS } from "@spi-code/core";
import type { WatchInput } from "./project.js";
import {
  briefingProvenance,
  readEnvelope,
  releaseProvenance,
  releasesTodayProvenance,
  stationProvenance,
} from "./provenance.js";
import { type RunHit, runProvenance } from "./recorded-runs.js";

export interface ProvenanceView {
  readonly briefing: Parameters<typeof briefingProvenance>[0];
  readonly places: readonly Pick<ValueSource, "areas">[];
  readonly stations: Parameters<typeof stationProvenance>[0];
  readonly releases: {
    readonly lines: readonly unknown[];
    readonly today?: Parameters<typeof releasesTodayProvenance>[0];
  };
  readonly platform: ReturnType<typeof platformReleased>;
  readonly services: readonly { readonly runs: readonly { readonly id: string }[] }[];
  readonly runs: readonly RunHit[];
}

/** Every drawn value's feeding areas, in snapshot order. */
export function snapshotProvenance(
  input: WatchInput,
  model: Model,
  now: Date,
  { briefing, places, stations, releases, platform, services, runs }: ProvenanceView,
) {
  return [
    ...briefingProvenance(briefing, model.stack),
    ...places.map((row, i) => ({ path: `/briefing/places/${i}`, areas: row.areas })),
    ...stationProvenance(stations),
    ...releaseProvenance(releases.lines, input.releaseRecords, now),
    {
      path: "/releases/forming",
      areas: ["fleet", "github"],
      envelope: readEnvelope("releases", input.releaseRecords, RELEASES_EVERY_MS, now),
    },
    ...releasesTodayProvenance(releases.today, input.releaseRecords, now, {
      stack: platform.stack?.source,
      template: platform.template?.source,
    }),
    ...services.flatMap((service, i) => [
      ...runProvenance(`/services/${i}/runs`, service.runs, runs, model.lines[i]?.fork.repo ?? ""),
      {
        path: `/services/${i}/releases`,
        areas: ["fleet", "github"],
        envelope: readEnvelope("releases", input.releaseRecords, RELEASES_EVERY_MS, now),
      },
    ]),
  ];
}
