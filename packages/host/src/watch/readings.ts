// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Anchor, Campaign, Reading, ReleaseDoc, WatchBriefing } from "@spi-code/contracts";
import { type Model, serviceReading, upstreamReading } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export interface ReadingContext {
  readonly model: Model;
  readonly input: WatchInput;
  readonly briefing: WatchBriefing;
  readonly documents: readonly ReleaseDoc[];
  readonly campaigns: readonly Campaign[];
}
type PlaceReader = (anchor: Anchor, context: ReadingContext) => Reading["content"];

export const readingFor: Record<Anchor["kind"], PlaceReader> = {
  program: (_anchor, _context) => null,
  upstream: (_anchor, { model, input, briefing }) =>
    upstreamReading({
      model,
      items: [...briefing.focus, ...briefing.rest],
      radar: (input.envelopeReads ?? input.reads).radar ?? [],
      fleet: input.context.fleet,
    }),
  service: (anchor, { model, input, briefing }) =>
    anchor.kind === "service"
      ? serviceReading({
          model,
          service: anchor.id,
          items: [...briefing.focus, ...briefing.rest],
          now: input.context.clock.now(),
        })
      : null,
  environment: (_anchor, _context) => null,
  engineering: (_anchor, _context) => null,
  releases: (_anchor, _context) => null,
  "release-month": (_anchor, _context) => null,
  security: (_anchor, _context) => null,
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
