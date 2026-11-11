// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { WatchBriefing, WatchItem } from "@spi-code/contracts";

/** Distinct Interrupts across focus and rest, first occurrence kept; items naming the same id count once. */
export function interruptsOf(briefing: Pick<WatchBriefing, "focus" | "rest">): WatchItem[] {
  const all = [...briefing.focus, ...briefing.rest];
  const identities = new Map<string, Set<string>>();
  for (const item of all) {
    const ids = new Set([item.id, ...item.ids]);
    for (const id of ids) {
      for (const alias of identities.get(id) ?? []) ids.add(alias);
    }
    for (const id of ids) identities.set(id, ids);
  }
  const seen = new Set<Set<string> | undefined>();
  return all.filter(({ id, attention }) => {
    if (attention !== "interrupt") return false;
    const identity = identities.get(id);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function countInterrupts(briefing: Pick<WatchBriefing, "focus" | "rest">): number {
  return interruptsOf(briefing).length;
}
