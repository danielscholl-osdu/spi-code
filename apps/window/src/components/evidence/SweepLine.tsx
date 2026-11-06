// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { useNow } from "./useNow.js";
import { sweepLine, sweepSources } from "./words.js";
import "./evidence.css";

export type SweepLineSnapshot = Pick<ViewSnapshot, "areas" | "provenance" | "sweptAt"> & {
  briefing: { nextSyncAt?: string | undefined };
};

/** The title bar's one sentence about the sweep (EV-03); a button that opens the sweep Evidence. */
export function SweepLine({
  snapshot,
  onOpen,
  now,
}: {
  snapshot: SweepLineSnapshot | null;
  onOpen(): void;
  now?: number | undefined;
}) {
  const clock = useNow();
  const at = now ?? clock;
  const { text, tone } =
    snapshot === null
      ? { text: "waiting for the first sweep", tone: "muted" as const }
      : sweepLine({
          sources: sweepSources(snapshot).map(({ envelope }) => envelope),
          sweptAt: snapshot.sweptAt,
          nextSyncAt: snapshot.briefing.nextSyncAt,
          now: at,
        });
  return (
    <button
      type="button"
      className="sweep-line"
      data-sweep-line=""
      data-tone={tone}
      aria-label={`${text}. Open the sweep evidence`}
      onClick={onOpen}
    >
      <span className="evidence-dot" data-tone={tone} aria-hidden />
      <span>{text}</span>
    </button>
  );
}
