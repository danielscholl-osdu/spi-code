// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Campaign, Reading, ReleaseDoc, WatchBriefing } from "@spi-code/contracts";
import type { Model } from "@spi-code/core";
import type { WatchInput } from "./project.js";

export function placeReadings(
  model: Model,
  _input: WatchInput,
  _briefing: WatchBriefing,
  documents: readonly ReleaseDoc[],
  campaigns: readonly Campaign[],
): Reading[] {
  return [
    ...(["program", "upstream", "environment", "engineering", "releases", "security"] as const).map(
      (kind) => ({ anchor: { kind }, content: null }),
    ),
    ...model.lines.map((line) => ({
      anchor: { kind: "service" as const, id: line.fork.id },
      content: null,
    })),
    ...documents.map((doc) => ({
      anchor: { kind: "release-month" as const, month: doc.month },
      content: null,
    })),
    ...campaigns.map((campaign) => ({
      anchor: { kind: "campaign" as const, id: campaign.id },
      content: null,
    })),
  ];
}
