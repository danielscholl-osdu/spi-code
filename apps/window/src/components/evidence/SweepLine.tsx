// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { Time } from "../../time.js";
import { useNow } from "./useNow.js";
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
  const now = useNow();
  const glyph =
    snapshot === null
      ? null
      : freshnessGlyph({
          sources: sweepSources(snapshot).map(({ envelope }) => envelope),
          sweptAt: snapshot.sweptAt,
          now,
        });
  const text = glyph?.text ?? "waiting for the first sweep";
  const tone = glyph?.tone ?? "muted";
  return (
    <button
      type="button"
      className="sweep-line"
      data-sweep-line=""
      data-field="freshness"
      data-tone={tone}
      aria-label={text}
      title={text}
      onClick={onOpen}
    >
      <span className="evidence-dot" data-tone={tone} aria-hidden />
      <span>
        {snapshot === null || glyph === null ? (
          text
        ) : (
          <>
            <Time at={snapshot.sweptAt} now={now} />
            {glyph.tail}
          </>
        )}
      </span>
    </button>
  );
}
