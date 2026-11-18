// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

/** Bind a number or range to its unit, leaving compound durations free to wrap between pairs. */
export function timeUnit(value: number | string, unit: "s" | "min" | "h" | "d"): string {
  return `${value}\u00a0${unit}`;
}

export interface WhenOptions {
  /** The moment the time is read against, in epoch milliseconds; the real clock when absent. */
  now?: number;
  /** An IANA zone; the process's own zone when absent. */
  timeZone?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const zones = new Map<string, Intl.DateTimeFormat>();

function calendar(date: Date, timeZone: string | undefined) {
  let year = date.getFullYear();
  let month = date.getMonth();
  let day = date.getDate();
  let hour = date.getHours();
  let minute = date.getMinutes();
  if (timeZone) {
    let format = zones.get(timeZone);
    if (!format) {
      format = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      });
      zones.set(timeZone, format);
    }
    const part = Object.fromEntries(
      format.formatToParts(date).map(({ type, value }) => [type, Number(value)]),
    );
    year = part.year ?? year;
    month = (part.month ?? month + 1) - 1;
    day = part.day ?? day;
    hour = part.hour ?? hour;
    minute = part.minute ?? minute;
  }
  // Whole calendar days since the epoch, so a DST change never shifts the day count.
  const days = Date.UTC(year, month, day) / 86_400_000;
  return {
    year,
    days,
    weekday: WEEKDAYS[(((days + 4) % 7) + 7) % 7],
    date: `${day} ${MONTHS[month]}`,
    clock: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/**
 * When something happened or will, on the operator's clock: time alone today, weekday and time
 * within six calendar days either way, and a date beyond (`14:05`, `Tue 09:30`, `3 Nov`).
 */
export function when(at: string | number | Date, options: WhenOptions = {}): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return typeof at === "string" ? at : "";
  const time = calendar(date, options.timeZone);
  const today = calendar(new Date(options.now ?? Date.now()), options.timeZone);
  const apart = Math.abs(time.days - today.days);
  if (apart === 0) return time.clock;
  if (apart < 7) return `${time.weekday} ${time.clock}`;
  return time.year === today.year ? time.date : `${time.date} ${time.year}`;
}
