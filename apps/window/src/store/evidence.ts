// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AreaEnvelope, AreaName, Envelope, ViewSnapshot } from "@spi-code/contracts";

type Evidence = Pick<ViewSnapshot, "areas" | "provenance">;

/** The area's envelope; the contract guarantees one per area, so absence reads as unread. */
export function areaEnvelope(snapshot: Evidence, area: AreaName): Envelope {
  return (
    snapshot.areas.find((entry) => entry.area === area)?.envelope ?? {
      source: area,
      state: "unread",
    }
  );
}

function within(path: string, prefix: string): boolean {
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Envelopes of every area feeding a value at or under the pointer prefix, including a value
 * that contains the pointer (a row feeds its fields), in the snapshot's area order.
 */
export function envelopesFor(snapshot: Evidence, pointerPrefix: string): AreaEnvelope[] {
  const feeding = new Set<AreaName>();
  for (const { path, areas } of snapshot.provenance) {
    if (within(path, pointerPrefix) || within(pointerPrefix, path)) {
      for (const area of areas) feeding.add(area);
    }
  }
  return snapshot.areas.filter(({ area }) => feeding.has(area));
}

/** True iff the pointer has provenance and every area it names is inferred-only. */
export function isInferred(snapshot: Evidence, pointer: string): boolean {
  const source = snapshot.provenance.find(({ path }) => path === pointer);
  return source?.areas.every((area) => areaEnvelope(snapshot, area).inferred === true) ?? false;
}
