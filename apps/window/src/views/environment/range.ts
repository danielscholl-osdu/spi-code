// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Environment, type EnvLane, inRange } from "@spi-code/contracts";
import type { EnvironmentRoute } from "../../app/navigation.js";
import { dateNames } from "../../time.js";

export const WEEK = "7-days";

export type Day = { key: string; start: number; end: number };

/** What the timeline draws: the last 24 hours, 7 days, or one day of them opened. */
export type Range = { from: number; to: number; label: string; week?: true; day?: Day };

/** The days core projected the range with, the last one ending at now. */
export function daysOf(env: Pick<Environment, "days" | "to">): Day[] {
  const days = env.days ?? [];
  return days.map(({ day, from }, index) => ({
    key: day,
    start: Date.parse(from),
    end: Date.parse(days[index + 1]?.from ?? env.to),
  }));
}

/** A day's names read from its date, not from any zone: `Thu 12` and `Thursday 12 Nov`. */
export const dayNames = ({ key }: Day) => dateNames(key);

export function rangeOf(
  env: Pick<Environment, "from" | "to" | "days" | "words">,
  range?: string,
): Range {
  const to = Date.parse(env.to);
  if (range === WEEK)
    return { from: Date.parse(env.from), to, label: env.words?.week ?? "", week: true };
  const day = range ? daysOf(env).find(({ key }) => key === range) : undefined;
  if (day) return { from: day.start, to: day.end, label: dayNames(day).long, day };
  return { from: to - 86_400_000, to, label: env.words?.day ?? "" };
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

type Span = Pick<Range, "from" | "to">;

/** The range holds [start, end); an open end runs to `to`, and a range ending at `to` is live. */
export const within = (range: Span, start: string, end: string | undefined, to: number) =>
  inRange(Date.parse(start), end ? Date.parse(end) : to, range.from, range.to, range.to >= to);

/** The lane's missed slots the range draws. */
export const missedIn = (lane: EnvLane, range: Span, to: number) =>
  lane.missed?.filter((at) => within(range, at, at, to)) ?? [];
