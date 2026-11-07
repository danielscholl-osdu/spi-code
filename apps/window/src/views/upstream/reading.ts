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

export const themeRow = (theme: Theme, index: number): SelectionRow => ({
  id: theme.inspect ?? `theme:${theme.id}`,
  title: theme.title,
  kind: "theme",
  prefixes: [`/briefing/themes/${index}`],
});

/** The ids the Upstream place lists, so a selection made here survives a sweep. */
export function upstreamSelectionIds(snapshot: ViewSnapshot): string[] {
  return [
    ...(upstreamReading(snapshot).content?.items.map(({ id }) => id) ?? []),
    ...snapshot.briefing.themes.map((theme, index) => themeRow(theme, index).id),
  ];
}
