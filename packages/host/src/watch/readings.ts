// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Anchor, Campaign, Reading, ReleaseDoc, WatchBriefing } from "@spi-code/contracts";
import {
  environmentReading,
  type Model,
  releasesReading,
  securityReading,
  serviceReading,
  upstreamReading,
} from "@spi-code/core";
import type { WatchInput } from "./project.js";

export interface ReadingContext {
  readonly model: Model;
  readonly input: WatchInput;
  readonly briefing: WatchBriefing;
  readonly documents: readonly ReleaseDoc[];
  readonly campaigns: readonly Campaign[];
}
type PlaceReader = (anchor: Anchor, context: ReadingContext) => Reading["content"];

// The current month's document is drawn from the calendar before any release read, so months
// reach a reading only once a release read succeeded or kept an earlier one.
function releasesRead(input: WatchInput): boolean {
  return input.releaseRecords.some((r) => r.failure === undefined || r.retainedFrom !== undefined);
}

export const readingFor: Record<Anchor["kind"], PlaceReader> = {
  program: (_anchor, _context) => null,
  upstream: (_anchor, { model, input, briefing, campaigns }) =>
    upstreamReading({
      model,
      items: [...briefing.focus, ...briefing.rest],
      radar: (input.envelopeReads ?? input.reads).radar ?? [],
      fleet: input.context.fleet,
      campaigns,
    }),
  service: (anchor, { model, input, briefing }) =>
    anchor.kind === "service"
      ? serviceReading({
          model,
          service: anchor.id,
          items: [...briefing.focus, ...briefing.rest],
          reads: Object.values(input.envelopeReads ?? input.reads).flatMap((area) => area ?? []),
          now: input.context.clock.now(),
        })
      : null,
  environment: (_anchor, { model, input, briefing }) => {
    const reads = input.envelopeReads ?? input.reads;
    return environmentReading({
      model,
      items: [...briefing.focus, ...briefing.rest],
      facts: input.facts,
      lifecycle: reads.lifecycle ?? [],
      reads: Object.values(reads).flatMap((area) => area ?? []),
      stackRepo: input.context.stackRepo,
      now: input.context.clock.now(),
    });
  },
  engineering: (_anchor, _context) => null,
  releases: (_anchor, { input, briefing, documents }) =>
    releasesReading({
      facts: input.facts,
      items: [...briefing.focus, ...briefing.rest],
      months: releasesRead(input) ? documents : [],
      reads: [...input.releaseRecords, ...((input.envelopeReads ?? input.reads).github ?? [])],
      context: input.context,
    }),
  "release-month": (_anchor, _context) => null,
  security: (_anchor, { model, input, briefing, campaigns }) =>
    securityReading({
      model,
      items: [...briefing.focus, ...briefing.rest],
      campaigns,
      reads: (input.envelopeReads ?? input.reads).security ?? [],
    }),
  campaign: (_anchor, _context) => null,
};

export function placeReadings(
  model: Model,
  input: WatchInput,
  briefing: WatchBriefing,
  documents: readonly ReleaseDoc[],
  campaigns: readonly Campaign[],
): Reading[] {
  const anchors: Anchor[] = [
    ...(["program", "upstream", "environment", "engineering", "releases", "security"] as const).map(
      (kind) => ({ kind }),
    ),
    ...model.lines.map((line) => ({
      kind: "service" as const,
      id: line.fork.id,
    })),
    ...documents.map((doc) => ({
      kind: "release-month" as const,
      month: doc.month,
    })),
    ...campaigns.map((campaign) => ({
      kind: "campaign" as const,
      id: campaign.id,
    })),
  ];
  const context: ReadingContext = { model, input, briefing, documents, campaigns };
  return anchors.map((anchor) => ({
    anchor,
    content: readingFor[anchor.kind](anchor, context),
  }));
}
