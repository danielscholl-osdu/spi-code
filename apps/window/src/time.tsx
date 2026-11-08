// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type React from "react";
import { useNow } from "./components/evidence/useNow.js";

export interface ClockOptions {
  /** The moment the time is read against; a later time gets a relative hint. */
  now?: number;
  /** An IANA zone; the window's own zone when absent. */
  timeZone?: string;
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
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)} h${rest > 0 ? ` ${rest} min` : ""}`;
  }
  return `${Math.round(minutes / (24 * 60))} d`;
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
  return ahead > 0 ? `${text} (in ${until(ahead)})` : text;
}

/** A visible time: {@link clockTime} in a `time` element whose `datetime` keeps the ISO value. */
export function Time({
  at,
  now,
  className,
}: {
  at: string;
  now?: number | undefined;
  className?: string | undefined;
}) {
  const tick = useNow();
  return (
    <time className={className} dateTime={at}>
      {clockTime(at, { now: now ?? tick })}
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

/** Text another layer composed, with each standalone ISO instant in it read through {@link Time}. */
export function TimedText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(instant)) {
    if (!valid(match)) continue;
    parts.push(text.slice(last, match.index), <Time key={match.index} at={match[0]} />);
    last = match.index + match[0].length;
  }
  if (last === 0) return text;
  parts.push(text.slice(last));
  return <>{parts}</>;
}
