// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { EnvEvent, EnvLane } from "@spi-code/contracts";

// Ported from keelson-rib-spi @59d6895, src/boards/console.ts.
export const TRACK_MIN_PX = 960;
const CHAR_PX = 6.6;
const BAR_MIN_PX = 10;
const LABEL_GAP_PX = 9;
export const TIER_PX = 22;
const MAX_TIERS = 6;

const glyph = { ok: "\u2713", failed: "\u2715", cancelled: "\u2298", running: "\u25cf", held: "" };
export const eventWord = {
  ok: "green",
  failed: "failed",
  cancelled: "cancelled",
  running: "running",
  held: "held",
};

export function eventText(e: EnvEvent): string {
  return glyph[e.state] ? `${glyph[e.state]} ${e.label}` : e.label;
}

export function eventKey(lane: EnvLane, e: EnvEvent): string {
  return `${lane.id}:${e.id}`;
}

// The inspector's id for an event: the queue item it folds into, else the run or the hold itself.
export function inspectId(lane: EnvLane, e: EnvEvent): string {
  return e.inspect ?? `${lane.id === "holds" ? "hold" : "run"}:${e.id}`;
}

export function pctOf(t: number, from: number, to: number): number {
  return Math.min(100, Math.max(0, ((t - from) / Math.max(1, to - from)) * 100));
}

export function fixed(n: number): string {
  return String(Math.round(n * 100) / 100);
}

export function place(events: readonly EnvEvent[], from: number, to: number) {
  const ends: number[] = [];
  const gap = (LABEL_GAP_PX / TRACK_MIN_PX) * 100;
  return [...events]
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((e) => {
      const left = pctOf(Date.parse(e.start), from, to);
      const right = pctOf(e.end ? Date.parse(e.end) : to, from, to);
      const width = Math.max(0, right - left);
      const bar = Math.max(width, (BAR_MIN_PX / TRACK_MIN_PX) * 100);
      const label = ((eventText(e).length * CHAR_PX) / TRACK_MIN_PX) * 100;
      const flip = left + bar + gap + label > 100;
      const start = flip ? left - gap - label : left;
      const end = flip ? left + bar : left + bar + gap + label;
      let tier = ends.findIndex((x) => x + gap <= start);
      if (tier < 0) tier = ends.length < MAX_TIERS ? ends.length : ends.indexOf(Math.min(...ends));
      ends[tier] = Math.max(ends[tier] ?? 0, end);
      return { e, left, width, tier, flip };
    });
}

export function hourTicks(from: number, to: number): { at: number; text: string }[] {
  const t = new Date(from);
  t.setMinutes(0, 0, 0);
  if (t.getTime() <= from) t.setHours(t.getHours() + 1);
  const out: { at: number; text: string }[] = [];
  for (; t.getTime() < to; t.setHours(t.getHours() + 1)) {
    out.push({ at: t.getTime(), text: `${String(t.getHours()).padStart(2, "0")}:00` });
  }
  return out;
}

function stamp(iso: string, now: Date): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "?";
  const two = (n: number) => String(n).padStart(2, "0");
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const today =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return today ? hm : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
}

// Ported from the rib's src/util.ts; use the track's clock, not the renderer wall clock.
function span(ms: number): string | undefined {
  const hour = 3_600_000;
  const day = 24 * hour;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < hour) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * day) {
    const m = Math.round((ms % hour) / 60_000);
    return `${Math.floor(ms / hour)} h${m > 0 ? ` ${m} min` : ""}`;
  }
  const h = Math.floor((ms % day) / hour);
  return `${Math.floor(ms / day)} d${h > 0 ? ` ${h} h` : ""}`;
}

export function eventWhen(e: EnvEvent, now: Date): string {
  const took = span((e.end ? Date.parse(e.end) : now.getTime()) - Date.parse(e.start));
  return `${stamp(e.start, now)} to ${e.end ? stamp(e.end, now) : "now"}${took ? ` \u00b7 ${took}` : ""}`;
}
