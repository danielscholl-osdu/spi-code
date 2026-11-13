// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { BriefFact, Reading } from "@spi-code/contracts";

export function runningFactHome(fact: BriefFact, { content }: Reading) {
  const versionTile =
    fact.label === "Running" && /^v\d/.test(fact.figure)
      ? (content?.tiles.findIndex(
          (tile) =>
            tile.label === "Version" &&
            tile.value === fact.figure &&
            tile.counts.split(" · ")[0] === "running",
        ) ?? -1)
      : -1;
  const subInHeadline =
    versionTile >= 0 &&
    /^ready(?: · green at .+)?$/.test(fact.sub) &&
    content?.headline ===
      `${fact.figure} is ${fact.sub.replace(" · green at ", ", green since ")}.`;
  return { versionTile, subInHeadline };
}
