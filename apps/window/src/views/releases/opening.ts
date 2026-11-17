// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ReleaseLine, ViewSnapshot } from "@spi-code/contracts";
import type { OpenSelection } from "../../app/navigation.js";
import type { BodyPlace, OpenedContent } from "../../components/opened-body/content.js";
import { itemContent } from "../../components/place/opening.js";

export type ReleasesOpening = { content: OpenedContent; month?: ReleaseLine };

const RELEASES = { kind: "releases" } as const;

/** What opens over Releases: a release month, or the item a release PR stands for. */
export function releasesOpening(
  snapshot: ViewSnapshot,
  open: OpenSelection | null,
): ReleasesOpening | undefined {
  if (!open) return undefined;
  const place: BodyPlace = { label: "Releases", destination: RELEASES, selection: open };
  if (open.kind === "item") {
    const content = itemContent(snapshot, open.id, place);
    return content && { content };
  }
  if (open.kind !== "release") return undefined;
  const month = snapshot.releases.lines.find(({ id }) => id === open.id);
  if (!month) return undefined;
  return { content: { title: `SPI ${month.name}`, place, subject: null }, month };
}
