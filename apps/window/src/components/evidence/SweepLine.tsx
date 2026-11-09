// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress, ViewSnapshot } from "@spi-code/contracts";
import { useEffect, useId, useState } from "react";
import { clockTime, Time } from "../../time.js";
import { settled } from "../sweep/words.js";
import { useNow } from "./useNow.js";
import { freshnessGlyph, sweepSources } from "./words.js";
import "./evidence.css";

export type SweepLineSnapshot = Pick<ViewSnapshot, "areas" | "provenance" | "sweptAt"> & {
  briefing: { nextSyncAt?: string | undefined };
};

/** Below this window width the first sweep's field drops "sweeping ·" and reads "9 of 12". */
export const SHORT_FRESHNESS_BELOW = 900;

const narrow = () => window.innerWidth < SHORT_FRESHNESS_BELOW;

function useShort(): boolean {
  const [short, setShort] = useState(narrow);
  useEffect(() => {
    const resize = () => setShort(narrow());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return short;
}

/**
 * The title bar's freshness glyph (EV-03); a button that opens the sweep Evidence. While a sweep
 * runs it carries the sweep: "sweeping · 9 of 12" before the first snapshot, the sweep time and
 * "sweeping 4 of 12" over an older one.
 */
export function SweepLine({
  snapshot,
  progress = null,
  onOpen,
}: {
  snapshot: SweepLineSnapshot | null;
  progress?: SweepProgress | null | undefined;
  onOpen(): void;
}) {
  const labelId = useId();
  const now = useNow();
  const short = useShort();
  const running = progress?.outcome === "running" ? progress : null;
  const count = running && `${settled(running)} of ${running.sources.length}`;
  const glyph =
    snapshot === null
      ? null
      : freshnessGlyph({
          sources: sweepSources(snapshot).map(({ envelope }) => envelope),
          sweptAt: snapshot.sweptAt,
          now,
        });
  const first = snapshot === null && count ? count : null;
  const later = snapshot !== null && running && !running.first ? count : null;
  const text = first
    ? `First sweep · ${first} sources done`
    : later && snapshot
      ? `Swept ${clockTime(snapshot.sweptAt, { now })} · sweeping, ${later} sources done`
      : (glyph?.text ?? "waiting for the first sweep");
  const tone = first || later ? "run" : (glyph?.tone ?? "muted");
  return (
    <button
      type="button"
      className="sweep-line"
      data-sweep-line=""
      data-field="freshness"
      data-tone={tone}
      aria-labelledby={labelId}
      title={text}
      onClick={onOpen}
    >
      <span className="evidence-dot" data-tone={tone} aria-hidden />
      <span id={labelId} className="visually-hidden">
        {text}
      </span>
      <span data-sweep-display="" aria-hidden>
        {first ? (
          short ? (
            first
          ) : (
            `sweeping · ${first}`
          )
        ) : snapshot === null || glyph === null ? (
          text
        ) : (
          <>
            <Time at={snapshot.sweptAt} now={now} />
            {later ? ` · sweeping ${later}` : glyph.tail}
          </>
        )}
      </span>
    </button>
  );
}
