// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Reading, Theme, ViewSnapshot } from "@spi-code/contracts";
import type { SelectionRow } from "../../panels/selection-rows.js";

export function upstreamReading(snapshot: ViewSnapshot): Reading {
  return (
    snapshot.readings.find(({ anchor }) => anchor.kind === "upstream") ?? {
      anchor: { kind: "upstream" },
      content: null,
    }
  );
}

/** A row for each Upstream item; a detected campaign reads its own forks. */
export function upstreamItemRows(snapshot: ViewSnapshot): SelectionRow[] {
  return (upstreamReading(snapshot).content?.items ?? []).map((item): SelectionRow => {
    const campaign = snapshot.campaigns.find(({ id }) => id === item.id);
    return {
      id: item.id,
      title: item.title,
      kind: "queue",
      inspectId: null,
      fields: [
        ...(item.cause ? [{ label: "Cause", value: item.cause }] : []),
        ...(campaign ? [{ label: "Forks", value: campaign.forks.join(", ") }] : []),
      ],
    };
  });
}

export const themeRow = (theme: Theme, index: number): SelectionRow => ({
  id: `theme:${theme.id}`,
  title: theme.title,
  kind: "theme",
  prefixes: [`/briefing/themes/${index}`],
});

/** The ids the Upstream place lists, so a selection made here survives a sweep. */
export function upstreamSelectionIds(snapshot: ViewSnapshot): string[] {
  return [
    ...(upstreamReading(snapshot).content?.items.map(({ id }) => id) ?? []),
    ...snapshot.briefing.themes.map((theme, index) => themeRow(theme, index).id),
    ...snapshot.briefing.themes.flatMap(({ inspect }) => (inspect ? [inspect] : [])),
  ];
}
