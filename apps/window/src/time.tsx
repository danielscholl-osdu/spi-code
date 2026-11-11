// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { timeUnit } from "@spi-code/contracts";
import type React from "react";
import { useNow } from "./components/evidence/useNow.js";

export { timeUnit };

export interface ClockOptions {
  /** The moment the time is read against; a later time gets a relative hint. */
  now?: number;
  /** An IANA zone; the window's own zone when absent. */
  timeZone?: string;
  /** False leaves out the relative hint, for copy that already says when. */
  hint?: boolean;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function fields(date: Date, timeZone: string | undefined) {
  const key = timeZone ?? "";
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formats.set(key, format);
  }
  const part = Object.fromEntries(
    format.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return {
    day: `${part.year}-${part.month}-${part.day}`,
    date: `${part.month}-${part.day}`,
    clock: `${part.hour}:${part.minute}`,
  };
}

function until(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return timeUnit(minutes, "min");
  if (minutes < 48 * 60) {
    const rest = minutes % 60;
    return `${timeUnit(Math.floor(minutes / 60), "h")}${rest > 0 ? ` ${timeUnit(rest, "min")}` : ""}`;
  }
  return timeUnit(Math.round(minutes / (24 * 60)), "d");
}

/**
 * The window's one reading of a time: a local 24-hour clock time, `MM-DD` first when it falls on
 * another day than `now`, and a relative hint when it is still to come: `09:36 (in 32 min)`.
 */
export function clockTime(at: string | number | Date, options: ClockOptions = {}): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return typeof at === "string" ? at : "";
  const now = options.now ?? Date.now();
  const time = fields(date, options.timeZone);
  const today = fields(new Date(now), options.timeZone);
  const text = time.day === today.day ? time.clock : `${time.date} ${time.clock}`;
  const ahead = date.getTime() - now;
  return ahead > 0 && options.hint !== false ? `${text} (in ${until(ahead)})` : text;
}

const days = new Map<string, Intl.DateTimeFormat>();

/** A day as a date line reads it, with no clock: `Friday 6 Nov`. */
export function dayLine(at: string | number | Date, options: Pick<ClockOptions, "timeZone"> = {}) {
  const key = options.timeZone ?? "";
  let format = days.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", {
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
      weekday: "long",
      day: "numeric",
      month: "short",
    });
    days.set(key, format);
  }
  return format.format(new Date(at));
}

/** A visible time: {@link clockTime} in a `time` element whose `datetime` keeps the ISO value. */
export function Time({
  at,
  now,
  className,
  hint,
}: {
  at: string;
  now?: number | undefined;
  className?: string | undefined;
  hint?: boolean | undefined;
}) {
  const tick = useNow();
  return (
    <time className={className} dateTime={at}>
      {clockTime(at, { now: now ?? tick, ...(hint === false ? { hint } : {}) })}
    </time>
  );
}

// A standalone instant: bounded by whitespace, brackets or quotes, or by closing punctuation at the
// end of a word, never inside an identifier or a URL.
const instant =
  /(?<=^|[\s([{"'])(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)(?=$|[\s)\]}"']|[.,;:!?](?:$|[\s)\]}"']))/g;

function valid(match: RegExpMatchArray): boolean {
  const [y, mo, d, h, mi, sec] = match.slice(1, 7).map((field) => Number(field ?? 0));
  const day = new Date(Date.UTC(y ?? 0, (mo ?? 0) - 1, d));
  return (
    day.getUTCMonth() === (mo ?? 0) - 1 &&
    day.getUTCDate() === d &&
    (h ?? 24) < 24 &&
    (mi ?? 60) < 60 &&
    (sec ?? 60) < 60 &&
    !Number.isNaN(Date.parse(match[0]))
  );
}

function instants(text: string): RegExpMatchArray[] {
  return [...text.matchAll(instant)].filter(valid);
}

/** The standalone ISO instants in composed text, as {@link TimedText} finds them. */
export function instantsIn(text: string): number[] {
  return instants(text).map(([iso]) => Date.parse(iso));
}

/** {@link TimedText} as a plain string, for an accessible name or a title. */
export function timedText(text: string, options: ClockOptions = {}): string {
  let out = "";
  let last = 0;
  for (const match of instants(text)) {
    out += text.slice(last, match.index) + clockTime(match[0], options);
    last = (match.index ?? 0) + match[0].length;
  }
  return out + text.slice(last);
}

/** Text another layer composed, with each standalone ISO instant in it read through {@link Time}. */
export function TimedText({ text, hint }: { text: string; hint?: boolean | undefined }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of instants(text)) {
    parts.push(text.slice(last, match.index), <Time key={match.index} at={match[0]} hint={hint} />);
    last = (match.index ?? 0) + match[0].length;
  }
  if (last === 0) return text;
  parts.push(text.slice(last));
  return <>{parts}</>;
}
