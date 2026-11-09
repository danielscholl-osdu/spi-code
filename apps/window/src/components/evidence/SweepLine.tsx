// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress, ViewSnapshot } from "@spi-code/contracts";
import { useId } from "react";
import { clockTime, Time } from "../../time.js";
import { settled } from "../sweep/words.js";
import { useNow } from "./useNow.js";
import { freshnessGlyph, sweepSources } from "./words.js";
import "./evidence.css";

export type SweepLineSnapshot = Pick<ViewSnapshot, "areas" | "provenance" | "sweptAt"> & {
  briefing: { nextSyncAt?: string | undefined };
};

const running = (progress: SweepProgress | null | undefined) =>
  progress?.outcome === "running" ? progress : null;

const counted = (progress: SweepProgress) => `${settled(progress)} of ${progress.sources.length}`;

/**
 * The first sweep's two display forms, "sweeping · 9 of 12" and the folded "9 of 12", or null when
 * the field does not carry a first sweep.
 */
export function firstSweepForms(
  snapshot: SweepLineSnapshot | null,
  progress: SweepProgress | null | undefined,
): { full: string; short: string } | null {
  const live = running(progress);
  if (snapshot !== null || !live) return null;
  const count = counted(live);
  return { full: `sweeping · ${count}`, short: count };
}

/**
 * The title bar's freshness glyph (EV-03); a button that opens the sweep Evidence. While a sweep
 * runs it carries the sweep: "sweeping · 9 of 12" before the first snapshot ("9 of 12" when the top
 * row's fold plan shortens it), the sweep time and "sweeping 4 of 12" over an older one.
 */
export function SweepLine({
  snapshot,
  progress = null,
  nextSweepAt = null,
  short = false,
  onOpen,
}: {
  snapshot: SweepLineSnapshot | null;
  progress?: SweepProgress | null | undefined;
  nextSweepAt?: string | null | undefined;
  short?: boolean;
  onOpen(): void;
}) {
  const labelId = useId();
  const now = useNow(30_000, nextSweepAt ? Date.parse(nextSweepAt) : undefined);
  const live = running(progress);
  const count = live && counted(live);
  const glyph =
    snapshot === null
      ? null
      : freshnessGlyph({
          sources: sweepSources(snapshot).map(({ envelope }) => envelope),
          sweptAt: snapshot.sweptAt,
          now,
        });
  const first = snapshot === null && count ? count : null;
  const later = snapshot !== null && live && !live.first ? count : null;
  const detail = first
    ? `First sweep · ${first} sources done`
    : later && snapshot
      ? `Swept ${clockTime(snapshot.sweptAt, { now })} · sweeping, ${later} sources done`
      : (glyph?.text ?? "waiting for the first sweep");
  const next = snapshot && nextSweepAt && Date.parse(nextSweepAt) > now ? nextSweepAt : null;
  const text = `${detail}${next ? ` · next sweep ${clockTime(next, { now, hint: false })}` : ""}`;
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
