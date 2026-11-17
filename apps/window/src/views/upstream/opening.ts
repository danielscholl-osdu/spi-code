// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import type { OpenSelection } from "../../app/navigation.js";
import type { BodyPlace, OpenedContent } from "../../components/opened-body/content.js";
import { itemContent, timed } from "../../components/place/opening.js";
import type { SelectionField } from "../../panels/selection-rows.js";

export type UpstreamOpening = { content: OpenedContent; fields: SelectionField[] };

const UPSTREAM = { kind: "upstream" } as const;

/** A theme's forks as SPI Code read them: certain or possible with their state, else exposed. */
function themeForks(theme: ViewSnapshot["briefing"]["themes"][number]): SelectionField[] {
  return [
    ...(["certain", "possible"] as const).flatMap((list) =>
      theme[list].map(({ fork, state, url }) => ({
        label: fork,
        value: `${list} · ${state}`,
        ...(url ? { href: url } : {}),
      })),
    ),
    ...theme.exposed.map((fork) => ({ label: fork, value: "exposed" })),
  ];
}

/** What opens over Upstream for the open selection: an item, or a Further ahead theme. */
export function upstreamOpening(
  snapshot: ViewSnapshot,
  open: OpenSelection | null,
): UpstreamOpening | undefined {
  if (!open) return undefined;
  const place: BodyPlace = { label: "Upstream", destination: UPSTREAM, selection: open };
  if (open.kind === "item") {
    const content = itemContent(snapshot, open.id, place);
    if (!content) return undefined;
    const campaign = snapshot.campaigns.find(({ id }) => id === open.id);
    return {
      content,
      fields: campaign ? [{ label: "Forks", value: campaign.forks.join(", ") }] : [],
    };
  }
  if (open.kind !== "theme") return undefined;
  const theme = snapshot.briefing.themes.find(({ id }) => id === open.id);
  if (!theme) return undefined;
  return {
    content: timed({
      title: theme.title,
      place,
      subject: null,
      steps: theme.next ? [theme.next] : [],
    }),
    fields: themeForks(theme),
  };
}
