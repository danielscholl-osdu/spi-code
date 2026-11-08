// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { Time } from "../../time.js";
import { freshnessGlyph, sweepSources } from "./words.js";
import "./evidence.css";

export type SweepLineSnapshot = Pick<ViewSnapshot, "areas" | "provenance" | "sweptAt"> & {
  briefing: { nextSyncAt?: string | undefined };
};

/** The title bar's freshness glyph (EV-03); a button that opens the sweep Evidence. */
export function SweepLine({
  snapshot,
  onOpen,
}: {
  snapshot: SweepLineSnapshot | null;
  onOpen(): void;
}) {
  const glyph =
    snapshot === null
      ? null
      : freshnessGlyph({
          sources: sweepSources(snapshot).map(({ envelope }) => envelope),
          sweptAt: snapshot.sweptAt,
        });
  const text = glyph?.text ?? "waiting for the first sweep";
  const tone = glyph?.tone ?? "muted";
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
      <span>
        {snapshot === null || glyph === null ? (
          text
        ) : (
          <>
            swept <Time at={snapshot.sweptAt} />
            {glyph.tail}
          </>
        )}
      </span>
    </button>
  );
}
