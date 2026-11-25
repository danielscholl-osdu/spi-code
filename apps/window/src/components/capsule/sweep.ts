// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope, SweepProgress } from "@spi-code/contracts";
import { clockTime } from "../../time.js";
import type { SweepLineSnapshot } from "../evidence/SweepLine.js";
import { freshnessGlyph, sweepSources } from "../evidence/words.js";
import { settled } from "../sweep/words.js";

export type SweepTone = "fine" | "warn" | "bad" | "run";

export type SweepSegmentView = {
  tone: SweepTone;
  icon: "refresh" | "alert" | "loader";
  /** The words beside the icon; absent when every source is fine, so the icon stands alone. */
  text?: string;
  sentence: string;
};

/** What the footer says of a settled sweep: the worst kind's count, or nothing when all is fine. */
export function sweepWords(sources: readonly Envelope[]): string | undefined {
  let failed = 0;
  let incomplete = 0;
  let stale = 0;
  for (const envelope of sources) {
    if (envelope.state === "failed") failed++;
    else if (envelope.state === "unread") continue;
    else if (envelope.state === "incomplete" || envelope.completeness.kind === "cut") incomplete++;
    else if (envelope.state === "stale") stale++;
  }
  if (failed > 0) return `${failed} failed`;
  if (incomplete > 0) return `${incomplete} incomplete`;
  if (stale > 0) return `${stale} stale`;
  return undefined;
}

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

/** The sweep's icon, tone and words, and the sentence its hover reads. */
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
      text: count(live),
      sentence: `Swept ${clockTime(snapshot.sweptAt, { now })} · sweeping, ${count(live)} sources done${tail}`,
    };
  const sources = sweepSources(snapshot).map(({ envelope }) => envelope);
  const tone = sweepTone(sources);
  const words = sweepWords(sources);
  return {
    tone,
    icon: tone === "fine" ? "refresh" : "alert",
    ...(words ? { text: words } : {}),
    sentence: `${freshnessGlyph({ sources, sweptAt: snapshot.sweptAt, now }).text}${tail}`,
  };
}

/** The share of sources settled while a sweep runs; null with no running sweep to measure. */
export function sweepFill(progress: SweepProgress | null | undefined): number | null {
  const live = running(progress);
  if (!live || live.sources.length === 0) return null;
  return settled(live) / live.sources.length;
}

/** One source's state in the popover, from its area envelope; only warn and bad are listed. */
export function sourceState(
  envelope: Envelope,
  now: number,
): { text: string; tone: "fine" | "warn" | "bad" | "unread" } {
  if (envelope.state === "unread") return { text: "not read yet", tone: "unread" };
  const at = envelope.observedAt ? clockTime(envelope.observedAt, { now, hint: false }) : null;
  const read = at ? `read ${at}` : "read";
  if (envelope.state === "failed")
    return { text: at ? `failed · showing ${at}` : "failed", tone: "bad" };
  if (envelope.completeness.kind === "cut") {
    const { read: got, total } = envelope.completeness;
    return {
      text: `read in part · ${got.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`,
      tone: "warn",
    };
  }
  if (envelope.state === "incomplete") return { text: `incomplete · ${read}`, tone: "warn" };
  if (envelope.state === "stale") return { text: `stale · ${read}`, tone: "warn" };
  return { text: read, tone: "fine" };
}
