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
 * The first sweep's two display forms beside the spinning mark, "sweeping" and the folded mark
 * alone, or null when the field does not carry a first sweep.
 */
export function firstSweepForms(
  snapshot: SweepLineSnapshot | null,
  progress: SweepProgress | null | undefined,
): { full: string; short: string } | null {
  if (snapshot !== null || !running(progress)) return null;
  return { full: "sweeping", short: "" };
}

/** The freshness field's mark: a dot in the field's tone, spinning while a sweep runs. */
export function SweepMark({ tone }: { tone: string }) {
  return (
    <span
      className="evidence-dot"
      data-tone={tone}
      {...(tone === "run" ? { "data-spin": "" } : {})}
      aria-hidden
    />
  );
}

/**
 * The title bar's freshness glyph (EV-03); a button that opens the sweep Evidence. While a sweep
 * runs its mark spins: beside "sweeping" before the first snapshot (the mark alone when the top
 * row's fold plan shortens it), beside the last sweep's time over an older one. The count stays in
 * the hover and accessible name.
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
      <SweepMark tone={tone} />
      <span id={labelId} className="visually-hidden">
        {text}
      </span>
      <span data-sweep-display="" aria-hidden>
        {first ? (
          short ? (
            ""
          ) : (
            "sweeping"
          )
        ) : snapshot === null || glyph === null ? (
          text
        ) : (
          <>
            <Time at={snapshot.sweptAt} now={now} />
            {!later && glyph.tail}
          </>
        )}
      </span>
    </button>
  );
}
