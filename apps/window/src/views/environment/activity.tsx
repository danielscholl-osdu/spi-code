// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { EnvActivitySegment, EnvEvent, Environment } from "@spi-code/contracts";
import type { ComponentProps, ReactNode } from "react";
import type { OpenSelection } from "../../app/navigation.js";
import { timeUnit } from "../../time.js";
import { borrowInRange } from "./borrows.js";
import { missedIn, within } from "./range.js";
import { eventWhen, eventWord, fixed, LABEL_PX, pctOf, span, TRACK_MIN_PX } from "./timeline.js";

export const IDLE_LABEL_SHARE = 1 / 8;
const MINUTE = 60_000;

/** A length the summary adds up with: days and hours keep their minutes. */
function exact(minutes: number): string | undefined {
  if (minutes < 2 * 1440) return span(minutes * MINUTE);
  const rest = minutes % 60;
  return `${span(Math.floor(minutes / 60) * 60 * MINUTE)}${rest ? ` ${timeUnit(rest, "min")}` : ""}`;
}

export function activityView(env: Environment, from: number, to: number, week?: boolean) {
  const { activity } = env;
  if (!activity) return undefined;
  const { words } = activity;
  const range = { from, to };
  const now = Date.parse(env.to);
  const borrows = env.borrows?.filter((borrow) => borrowInRange(borrow, from, to)) ?? [];
  const segments = activity.segments.flatMap((segment) => {
    const start = Math.max(from, Date.parse(segment.start));
    const end = Math.min(to, Date.parse(segment.end));
    return end > start ? [{ segment, start, end }] : [];
  });
  const totals = { borrowed: 0, maintenance: 0, idle: 0, overlap: 0 };
  for (const { segment, start, end } of segments) {
    const { kind } = segment;
    const length = end - start;
    if (kind === "overlap") totals.overlap += length;
    totals[kind === "maintenance" || kind === "idle" ? kind : "borrowed"] += length;
  }
  const parts = ["borrowed", "maintenance", "idle"] as const;
  const minutes = (ms: number) => (ms > 0 ? Math.max(1, Math.round(ms / MINUTE)) : 0);
  // The parts share the range's rounded minutes, the spare ones going to the largest remainders.
  const rangeMinutes = Math.round(parts.reduce((sum, part) => sum + totals[part], 0) / MINUTE);
  const rounded = {
    borrowed: Math.floor(totals.borrowed / MINUTE),
    maintenance: Math.floor(totals.maintenance / MINUTE),
    idle: Math.floor(totals.idle / MINUTE),
  };
  let spare = rangeMinutes - parts.reduce((sum, part) => sum + rounded[part], 0);
  for (const part of [...parts].sort((a, b) => (totals[b] % MINUTE) - (totals[a] % MINUTE)))
    if (spare-- > 0) rounded[part] += 1;
  const approximate = borrows.some(({ estimated }) => estimated);
  const countWord = borrows.length === 1 ? "borrow" : "borrows";
  const summary: { part: keyof typeof words; text: string }[] = borrows.length
    ? [{ part: countWord, text: `${borrows.length} ${words[countWord]}` }]
    : [];
  for (const part of [...parts, "overlap"] as const) {
    const length =
      part === "overlap" ? Math.min(minutes(totals.overlap), rounded.borrowed) : rounded[part];
    if (length > 0) {
      const prefix = part === "borrowed" && approximate ? "≈" : "";
      summary.push({ part, text: `${prefix}${exact(length)} ${words[part]}` });
    }
  }
  const holds =
    env.lanes
      .find(({ id }) => id === "holds")
      ?.events.filter((event) => within(range, event.start, event.end, now))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) ?? [];
  const runs = env.lanes.filter(({ id }) => id !== "holds");
  const events = runs.flatMap(({ events }) =>
    events.filter(({ start, end }) => within(range, start, end, now)),
  );
  const has = (kind: EnvActivitySegment["kind"]) =>
    segments.some(({ segment }) => segment.kind === kind);
  const legend = (
    [
      [
        "ok",
        eventWord.ok,
        events.some(({ state }) => state === "ok") ||
          borrows.some(({ result }) => result === "green"),
      ],
      [
        "failed",
        eventWord.failed,
        events.some(({ state }) => state === "failed") ||
          borrows.some(({ result }) => result === "failed"),
      ],
      [
        "running",
        eventWord.running,
        events.some(({ state }) => state === "running") ||
          borrows.some(({ result }) => result === "running"),
      ],
      ["cancelled", eventWord.cancelled, events.some(({ state }) => state === "cancelled")],
      ["borrowed", words.borrowed, has("borrowed")],
      ["estimated", words.estimated, !week && (approximate || has("estimated"))],
      [
        "unknown",
        words.unknown,
        !week && borrows.some(({ result, end }) => !end && result !== "running"),
      ],
      ["maintenance", words.maintenance, holds.length > 0],
      ["overlap", words.overlap, has("overlap")],
      ["missed", words.missed, runs.some((lane) => missedIn(lane, range, now).length > 0)],
      ["byHand", words.byHand, events.some(({ byHand }) => byHand)],
    ] as const
  ).filter(([, , shown]) => shown);
  return { label: activity.label, words, segments, holds, summary, legend };
}

type ActivityView = NonNullable<ReturnType<typeof activityView>>;

export function ActivitySummary({
  view,
  children,
}: {
  view: ActivityView | undefined;
  children?: ReactNode;
}) {
  if (!view?.summary.length && !children) return null;
  return (
    <p className="env-activity-summary">
      {children}
      {view?.summary.map(({ part, text }, index) => (
        <span key={part}>
          {index > 0 && " · "}
          <span data-part={part}>{text}</span>
        </span>
      ))}
    </p>
  );
}

export function ActivityLegend({ view }: { view: ActivityView }) {
  if (!view.legend.length) return null;
  return (
    <div className="env-legend">
      {view.legend.map(([mark, label]) => (
        <span key={mark} data-legend={mark}>
          <i className="env-activity-mark" data-mark={mark} aria-hidden="true" />
          {label}
        </span>
      ))}
    </div>
  );
}

export function ActivityRow({
  view,
  from,
  to,
  opener,
  week,
}: {
  view: ActivityView;
  from: number;
  to: number;
  opener: (selection: OpenSelection) => ComponentProps<"button">;
  week?: boolean | undefined;
}) {
  const pct = (at: number) => pctOf(at, from, to);
  const band = (start: number, end: number) => ({
    left: `min(${fixed(pct(start))}%, calc(100% - 3px))`,
    width: `${fixed(pct(end) - pct(start))}%`,
  });
  const now = new Date(to);
  return (
    <div className="env-row env-activity">
      <div className="env-lane-label">{view.label}</div>
      <div className="env-track">
        {view.segments.map(({ segment, start, end }) => {
          const { kind, title } = segment;
          if (kind === "idle") {
            return end - start > (to - from) * IDLE_LABEL_SHARE ? (
              <span
                className="env-idle-label"
                key={segment.start}
                style={{ left: `${fixed(pct((start + end) / 2))}%` }}
              >
                {view.words.idle} {span(end - start)}
              </span>
            ) : null;
          }
          if (kind === "maintenance") return null;
          const text = `${title} · ${eventWhen(segment, now)}`;
          return (
            <button
              type="button"
              className="env-activity-mark"
              data-mark={kind}
              key={segment.start}
              aria-label={text}
              style={band(start, end)}
              {...opener({ kind: "activity", id: segment.start })}
            />
          );
        })}
        {view.holds.map((event: EnvEvent) => {
          const start = Date.parse(event.start);
          const end = event.end ? Date.parse(event.end) : to;
          const label = `${start < from ? "‹ " : ""}${event.label}`;
          const room = ((label.length * 7) / (TRACK_MIN_PX - LABEL_PX)) * 100;
          const placement =
            pct(end) - pct(start) >= room
              ? "inside"
              : week
                ? undefined
                : pct(end) + room > 100
                  ? "before"
                  : "after";
          const id = `holds:${event.id}`;
          return (
            <button
              type="button"
              className={`env-activity-mark${event.end ? "" : " open"}`}
              data-mark="maintenance"
              key={id}
              data-event={id}
              data-inspect={event.inspect}
              style={band(start, end)}
              aria-label={`${view.words.held} ${event.label}, ${eventWhen(event, now)}`}
              {...opener({ kind: "event", id })}
            >
              {placement && (
                <span className="env-hold-label" data-placement={placement}>
                  {label}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
