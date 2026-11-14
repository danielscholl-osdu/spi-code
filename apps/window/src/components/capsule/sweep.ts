// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope, SweepProgress } from "@spi-code/contracts";
import { clockTime, dayLine } from "../../time.js";
import type { SweepLineSnapshot } from "../evidence/SweepLine.js";
import { freshnessGlyph, sweepSources } from "../evidence/words.js";
import { settled } from "../sweep/words.js";

export type SweepTone = "fine" | "warn" | "bad" | "run";

export type SweepSegmentView = {
  tone: SweepTone;
  icon: "refresh" | "alert" | "loader";
  /** The words beside the icon; absent when the sweep time stands there instead. */
  text?: string;
  sweptAt?: string;
  sentence: string;
};

/** The worst area wins: failed, then stale, incomplete or cut, then fine. */
export function sweepTone(sources: readonly Envelope[]): Exclude<SweepTone, "run"> {
  if (sources.some(({ state }) => state === "failed")) return "bad";
  if (
    sources.some(
      (envelope) =>
        envelope.state === "stale" ||
        envelope.state === "incomplete" ||
        (envelope.state !== "unread" && envelope.completeness.kind === "cut"),
    )
  )
    return "warn";
  return "fine";
}

const running = (progress: SweepProgress | null | undefined) =>
  progress?.outcome === "running" ? progress : null;

const count = (progress: SweepProgress) => `${settled(progress)} of ${progress.sources.length}`;

/** The capsule's last segment: its icon, tone and words, and the sentence its hover reads. */
export function sweepSegment(
  snapshot: SweepLineSnapshot | null,
  progress: SweepProgress | null | undefined,
  nextSweepAt: string | null | undefined,
  now: number,
): SweepSegmentView {
  const live = running(progress);
  if (!snapshot) {
    if (live)
      return {
        tone: "run",
        icon: "loader",
        text: "First sweep",
        sentence: `First sweep · ${count(live)} sources done`,
      };
    if (progress?.outcome === "failed" || progress?.outcome === "cancelled")
      return {
        tone: "bad",
        icon: "alert",
        text: "First sweep stopped",
        sentence: "First sweep stopped",
      };
    return {
      tone: "fine",
      icon: "refresh",
      text: "Not swept",
      sentence: "Waiting for the first sweep",
    };
  }
  const next = nextSweepAt && Date.parse(nextSweepAt) > now ? nextSweepAt : null;
  const tail = next ? ` · next sweep ${clockTime(next, { now, hint: false })}` : "";
  if (live)
    return {
      tone: "run",
      icon: "loader",
      text: "Sweeping",
      sentence: `Swept ${clockTime(snapshot.sweptAt, { now })} · sweeping, ${count(live)} sources done${tail}`,
    };
  const sources = sweepSources(snapshot).map(({ envelope }) => envelope);
  const tone = sweepTone(sources);
  return {
    tone,
    icon: tone === "fine" ? "refresh" : "alert",
    sweptAt: snapshot.sweptAt,
    sentence: `${freshnessGlyph({ sources, sweptAt: snapshot.sweptAt, now }).text}${tail}`,
  };
}

/** The share of sources settled while a sweep runs; null with no running sweep to measure. */
export function sweepFill(progress: SweepProgress | null | undefined): number | null {
  const live = running(progress);
  if (!live || live.sources.length === 0) return null;
  return settled(live) / live.sources.length;
}

/** One source's state in the popover, from its area envelope. */
export function sourceState(
  envelope: Envelope,
  now: number,
): { text: string; tone: "fine" | "warn" | "bad" } {
  if (envelope.state === "unread") return { text: "not read yet", tone: "fine" };
  const at = envelope.observedAt ? clockTime(envelope.observedAt, { now, hint: false }) : null;
  const read = at ? `read ${at}` : "read";
  if (envelope.state === "failed")
    return { text: at ? `failed, last ${read}` : "failed", tone: "bad" };
  if (envelope.completeness.kind === "cut") return { text: `cut, ${read}`, tone: "warn" };
  if (envelope.state === "incomplete") return { text: `incomplete, ${read}`, tone: "warn" };
  if (envelope.state === "stale") return { text: `stale, ${read}`, tone: "warn" };
  return { text: read, tone: "fine" };
}

const DAY_MS = 86_400_000;

/**
 * A time still to come in its short form: `18:00 · in 40m` today, `Sat 18:00 · in 22h` this week,
 * `11-21 18:00 · in 8d` beyond it. Null when the time is unknown or already past.
 */
export function shortWhen(at: string | null | undefined, now: number): string | null {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!at || !(time > now)) return null;
  const clock = clockTime(at, { now: time, hint: false });
  const dated = clockTime(at, { now, hint: false });
  const ahead = time - now;
  const day = dated === clock ? "" : ahead < 6 * DAY_MS ? `${dayLine(at).slice(0, 3)} ` : "";
  const minutes = Math.max(1, Math.floor(ahead / 60_000));
  const until =
    minutes < 60
      ? `${minutes}m`
      : minutes < 48 * 60
        ? `${Math.floor(minutes / 60)}h`
        : `${Math.floor(ahead / DAY_MS)}d`;
  return `${day}${day ? clock : dated} · in ${until}`;
}
