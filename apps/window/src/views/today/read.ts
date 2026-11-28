// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress, ViewSnapshot } from "@spi-code/contracts";
import { AREA_NAMES } from "../../components/evidence/words.js";
import { settled } from "../../components/sweep/words.js";

/** Areas whose read failed or was cut this sweep, in the snapshot's area order. */
export function caveatAreas(snapshot: Pick<ViewSnapshot, "areas">) {
  return snapshot.areas.filter(
    ({ envelope }) => envelope.state === "failed" || envelope.state === "incomplete",
  );
}

/** What Today's header and its empty line know of the read: one of four states, or two at once. */
export type TodayRead = {
  /** The sweep Today shows, or null before the first one is saved. */
  sweptAt: string | null;
  /** A sweep is requested or running. */
  reading: boolean;
  /** Sources settled of all, while a sweep runs; null when no running sweep has reported. */
  count: { done: number; of: number } | null;
  /** What was not read in full, each named. */
  gaps: string[];
  /** The fleet's fork count; null when the snapshot holds no fleet. */
  forks: number | null;
};

export function todayRead(
  snapshot: ViewSnapshot | null,
  progress: SweepProgress | null,
  requested: boolean,
): TodayRead {
  const running = progress?.outcome === "running";
  const fleet = snapshot?.briefing.today?.fleet;
  return {
    sweptAt: snapshot?.sweptAt ?? null,
    reading: requested || running,
    count: running ? { done: settled(progress), of: progress.sources.length } : null,
    gaps: snapshot
      ? caveatAreas(snapshot).map(
          ({ area, envelope }) =>
            `${AREA_NAMES[area]} ${envelope.state === "failed" ? "read failed" : "read only in part"}`,
        )
      : [],
    forks: fleet ? fleet.forks.yours.length + fleet.forks.rest.forks.length : null,
  };
}
