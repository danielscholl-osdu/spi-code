// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { WatchBriefing } from "@spi-code/contracts";

export function selectTodayItems(briefing: Pick<WatchBriefing, "focus" | "rest">) {
  const all = [...briefing.focus, ...briefing.rest];
  const focus = briefing.focus
    .filter(({ attention, owned }) => attention === "interrupt" || attention === "surface" || owned)
    .slice(0, 5);
  const focusIds = new Set(focus.map(({ id }) => id));
  const folded = all.filter(({ id }) => !focusIds.has(id));
  const identities = new Map<string, Set<string>>();
  for (const item of all) {
    const ids = new Set([item.id, ...item.ids]);
    for (const id of ids) {
      for (const alias of identities.get(id) ?? []) ids.add(alias);
    }
    for (const id of ids) identities.set(id, ids);
  }
  const interrupts = new Set(
    all.filter(({ attention }) => attention === "interrupt").map(({ id }) => identities.get(id)),
  ).size;
  return { focus, folded, interrupts };
}
