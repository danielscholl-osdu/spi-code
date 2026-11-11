// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { WatchBriefing } from "@spi-code/contracts";

/** Distinct Interrupts across focus and rest; items naming the same id count once. */
export function countInterrupts(briefing: Pick<WatchBriefing, "focus" | "rest">): number {
  const all = [...briefing.focus, ...briefing.rest];
  const identities = new Map<string, Set<string>>();
  for (const item of all) {
    const ids = new Set([item.id, ...item.ids]);
    for (const id of ids) {
      for (const alias of identities.get(id) ?? []) ids.add(alias);
    }
    for (const id of ids) identities.set(id, ids);
  }
  return new Set(
    all.filter(({ attention }) => attention === "interrupt").map(({ id }) => identities.get(id)),
  ).size;
}
