// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Environment, EnvLane } from "@spi-code/contracts";
import type { EnvironmentRoute } from "../../app/navigation.js";
import { dayLine } from "../../time.js";

export const WEEK = "7-days";

export type Day = { key: string; start: number; end: number };

/** What the timeline draws: the last 24 hours, 7 days, or one day of them opened. */
export type Range = { from: number; to: number; label: string; week?: true; day?: Day };

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** The local days from the briefing's `from` to now, the last one ending at now. */
export function daysOf(env: Pick<Environment, "from" | "to">): Day[] {
  const from = Date.parse(env.from);
  const to = Date.parse(env.to);
  const days: Day[] = [];
  for (let start = new Date(from); start.getTime() < to; ) {
    const next = new Date(start);
    next.setDate(next.getDate() + 1);
    next.setHours(0, 0, 0, 0);
    days.push({ key: keyOf(start), start: start.getTime(), end: Math.min(to, next.getTime()) });
    start = next;
  }
  return days;
}

export function rangeOf(env: Pick<Environment, "from" | "to">, range?: string): Range {
  const to = Date.parse(env.to);
  if (range === WEEK) return { from: Date.parse(env.from), to, label: "Last 7 days", week: true };
  const day = range ? daysOf(env).find(({ key }) => key === range) : undefined;
  if (day) return { from: day.start, to: day.end, label: dayLine(day.start), day };
  return { from: to - 86_400_000, to, label: "Last 24 hours" };
}

export const routeOf = (range: Range): EnvironmentRoute => ({
  kind: "environment",
  ...(range.week ? { range: WEEK } : range.day ? { range: range.day.key } : {}),
});

/** A lane's last run for the range, as core sent it: the 24-hour one, or the one for 7 days or its day. */
export function lastOf(lane: EnvLane, range: Range) {
  if (!range.week && !range.day) return lane.last;
  return lane.lasts?.find(
    (last) => Date.parse(last.from) === range.from && Date.parse(last.to) === range.to,
  );
}

/** The range includes [start, end]; an open end runs to `to`. */
export const within = (range: Range, start: string, end: string | undefined, to: number) =>
  Date.parse(start) <= range.to && (end ? Date.parse(end) : to) >= range.from;
