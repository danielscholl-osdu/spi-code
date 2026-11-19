// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { inRange, timeUnit } from "@spi-code/contracts";
import { when } from "@spi-code/contracts";
import { HISTORY_DAYS, type LifecycleKind } from "../config.js";
import type { CoreContext } from "../context.js";
import type { DeploymentFact, LifecycleRun } from "../facts.js";
import { MISSED_AFTER_MS, median } from "../model/history.js";
import type { ForkDeployments, Model } from "../model/index.js";
import { cadence, firesBetween, wallClock } from "../model/schedule.js";
import { replayHolds, type RunView, runResult, semverCmp, viewRun } from "../model/stack.js";
import { span, stamp } from "../util.js";
import type { EnvLane, Link } from "./index.js";
import { deployableWords } from "./words.js";

export interface EnvBorrow {
  id: string;
  fork: string;
  branch?: string;
  result: "green" | "failed" | "running" | "unknown";
  detail: string;
  homeLabel: string;
  start: string;
  end?: string;
  estimated?: true;
  links: Link[];
  overlap?: string;
}

export interface EnvStatus {
  state: "maintenance" | "in-use" | "unknown" | "idle";
  label: string;
  length?: string;
  reason?: string;
  live?: { fork: string; id: string }[];
}

const DAY = 86_400_000;

function dateKeyIn(context: CoreContext) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: context.timeZone ?? "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format;
}

/** The first instant of a local date, including a midnight clock change. */
function midnightOf(target: string, dateKey: (at: number) => string): number {
  const guess = Date.parse(target);
  let lo = guess - DAY;
  let hi = guess + DAY;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKey(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function environmentFrom(now: Date, context: CoreContext): number {
  if (context.words !== "app") return now.getTime() - DAY;
  const dateKey = dateKeyIn(context);
  const localDay = Date.parse(dateKey(now));
  return midnightOf(new Date(localDay - 6 * DAY).toISOString().slice(0, 10), dateKey);
}

/** The local dates from `from` up to `to` and the instant each starts, `from` first. */
function localDays(from: number, to: number, context: CoreContext): { day: string; start: number }[] {
  const dateKey = dateKeyIn(context);
  const days = [{ day: dateKey(from), start: from }];
  for (let day = Date.parse(dateKey(from)) + DAY; ; day += DAY) {
    const key = new Date(day).toISOString().slice(0, 10);
    const start = midnightOf(key, dateKey);
    if (start >= to) return days;
    days.push({ day: key, start });
  }
}

/** The days the 7-day range is drawn and opened by, so the window never reads them in its own zone. */
export function environmentDays(from: number, now: Date, context: CoreContext): { day: string; from: string }[] {
  return localDays(from, now.getTime(), context).map(({ day, start }) => ({ day, from: new Date(start).toISOString() }));
}

function result(state: DeploymentFact["state"]): EnvBorrow["result"] {
  if (state === "SUCCESS") return "green";
  if (state === "FAILURE" || state === "ERROR") return "failed";
  return state === "IN_PROGRESS" ? "running" : "unknown";
}

function borrowEnd(deploy: DeploymentFact, to: number): number | undefined {
  const state = result(deploy.state);
  const end = Date.parse(deploy.statusAt ?? "");
  return (state === "green" || state === "failed") && end >= Date.parse(deploy.createdAt) && end <= to
    ? end : undefined;
}

function borrowList(histories: readonly ForkDeployments[], now: Date, context: CoreContext): EnvBorrow[] {
  const to = now.getTime();
  const typical = median(histories.flatMap(({ deployments }) => deployments.flatMap((deploy) => {
    const end = borrowEnd(deploy, to);
    return end === undefined ? [] : [end - Date.parse(deploy.createdAt)];
  })));
  return histories.flatMap(({ fork, deployments }) => {
    const ordered = deployments
      .filter(({ createdAt }) => Date.parse(createdAt) <= to)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return ordered.map((deploy, index): EnvBorrow => {
      const start = Date.parse(deploy.createdAt);
      const next = ordered[index + 1];
      const estimate = deploy.state === "INACTIVE" && typical !== undefined
        ? Math.min(start + typical, next ? Date.parse(next.createdAt) : to)
        : undefined;
      const end = borrowEnd(deploy, to) ?? estimate;
      const startAt = new Date(start).toISOString();
      const endAt = end === undefined ? undefined : new Date(end).toISOString();
      const outcome = result(deploy.state);
      const estimated = estimate !== undefined;
      const since = environmentAt(startAt, now, context);
      const until = endAt
        ? `${estimated ? "≈\u00a0" : ""}${environmentAt(endAt, now, context)}`
        : outcome === "running" ? "now" : undefined;
      const time = until === undefined ? since
        : `${since} to ${until} · ${estimated ? "≈" : ""}${span((end ?? to) - start)}`;
      return {
        id: `${fork}:${deploy.id ?? `${deploy.createdAt}:${deploy.sha ?? ""}:${index}`}`,
        fork,
        ...(deploy.ref ? { branch: deploy.ref } : {}),
        result: outcome,
        detail: `${outcome} · ${time}`,
        homeLabel: `${fork} home`,
        start: startAt,
        ...(endAt ? { end: endAt } : {}),
        ...(estimated ? { estimated: true } : {}),
        links: [
          ...(deploy.runUrl ? [{ kind: "run" as const, label: "Run", url: deploy.runUrl }] : []),
          ...(deploy.deploymentUrl
            ? [{ kind: "deploy" as const, label: "Deployment", url: deploy.deploymentUrl }]
            : []),
        ],
      };
    });
  }).sort((a, b) => b.start.localeCompare(a.start));
}

const distinct = <T>(values: Iterable<T>): T[] => [...new Set(values)];
const forksText = (forks: readonly string[]) =>
  forks.length > 3 ? `${forks.length} forks` : forks.join(", ");

function incompleteNote(histories: readonly ForkDeployments[], from: number): string | undefined {
  if (histories.length === 0) return "Fork deployments not read";
  const unread = histories.filter(({ read }) => read === "unread").map(({ fork }) => fork);
  const capped = histories.filter(({ read, deployments }) =>
    read === "capped" && !deployments.some(({ createdAt }) => Date.parse(createdAt) <= from),
  ).map(({ fork }) => fork);
  const notes = [
    unread.length ? `${forksText(unread)} not read` : undefined,
    capped.length ? `${forksText(capped)} history incomplete` : undefined,
  ].filter(Boolean);
  return notes.length ? notes.join(" · ") : undefined;
}

type Interval = { start: number; end: number };
function measured(borrow: EnvBorrow): Interval | undefined {
  return borrow.end && !borrow.estimated
    ? { start: Date.parse(borrow.start), end: Date.parse(borrow.end) }
    : undefined;
}

function overlapOf(borrow: EnvBorrow, others: readonly EnvBorrow[], to: number): string | undefined {
  const intervalOf = (item: EnvBorrow) =>
    item.result === "running" ? { start: Date.parse(item.start), end: to } : measured(item);
  const own = intervalOf(borrow);
  if (!own) return undefined;
  const overlaps = others.flatMap((other) => {
    const interval = other.fork !== borrow.fork ? intervalOf(other) : undefined;
    if (!interval) return [];
    const start = Math.max(own.start, interval.start);
    const end = Math.min(own.end, interval.end);
    return end > start ? [{ start, end, fork: other.fork }] : [];
  }).sort((a, b) => a.start - b.start);
  let duration = 0;
  let end = own.start;
  for (const interval of overlaps) {
    duration += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return duration ? `Overlapped ${forksText(distinct(overlaps.map(({ fork }) => fork)))} for ${span(duration)}` : undefined;
}

function usageLength(ms: number): string | undefined {
  if (ms < DAY || ms >= 2 * DAY) return span(ms);
  const hours = Math.floor((ms - DAY) / 3_600_000);
  return hours ? `${timeUnit(1, "d")} ${timeUnit(hours, "h")}` : timeUnit(1, "d");
}

function environmentAt(iso: string, now: Date, context: CoreContext): string {
  return context.timeStyle === "instant"
    ? stamp(iso, now, context) ?? ""
    : when(iso, { now: now.getTime(), timeZone: context.timeZone ?? "UTC" });
}

function statusOf(
  model: Model, lanes: readonly EnvLane[], borrows: readonly EnvBorrow[],
  note: string | undefined, now: Date, context: CoreContext,
): EnvStatus {
  const to = now.getTime();
  const at = (iso: string) => environmentAt(iso, now, context);
  const hold = lanes.find(({ id }) => id === "holds")?.events.find(({ end }) => !end);
  if (hold) {
    const run = model.stack.maintenance.run;
    const what = run?.kind === "upgrade" ? "Upgrade" : run?.kind === "reset" ? "Reset" : "Refresh";
    return {
      state: "maintenance",
      label: "In maintenance",
      length: usageLength(to - Date.parse(hold.start)),
      ...(run ? { reason: `${what}${run.target ? ` ${run.target}` : ""} ${runResult(run)} ${at(run.status === "completed" ? run.updatedAt : run.createdAt)}`.trim() } : {}),
    };
  }
  const live = borrows.filter(({ result }) => result === "running");
  const intervals = borrows.flatMap((borrow) => {
    const item = measured(borrow);
    return item ? [{ borrow, ...item }] : [];
  }).sort((a, b) => b.end - a.end);
  if (live.length) {
    let since = Math.min(...live.map(({ start }) => Date.parse(start)));
    for (const interval of intervals) {
      if (interval.end < since) break;
      since = Math.min(since, interval.start);
    }
    return {
      state: "in-use", label: "In use", length: usageLength(to - since),
      live: live.filter(({ fork }, index) => live.findIndex((borrow) => borrow.fork === fork) === index)
        .map(({ fork, id }) => ({ fork, id })),
    };
  }
  if (note) return { state: "unknown", label: "Usage unknown", reason: note };
  const last = intervals[0];
  const unresolved = last && model.forkDeployments.some(({ deployments }) => {
    const latestBeforeEnd = deployments.reduce((latest, { createdAt }) => {
      const start = Date.parse(createdAt);
      return start <= last.end ? Math.max(latest, start) : latest;
    }, -Infinity);
    return deployments.some((deploy) => {
      const start = Date.parse(deploy.createdAt);
      if (!(start <= to) || borrowEnd(deploy, to) !== undefined) return false;
      if (["PENDING", "QUEUED", "WAITING"].includes(deploy.state ?? "")) return false;
      return !(deploy.state === "INACTIVE" &&
        (start < latestBeforeEnd || Date.parse(deploy.statusAt ?? "") <= last.end));
    });
  });
  return {
    state: "idle",
    label: "Idle",
    ...(last && !unresolved && last.borrow.end
      ? { length: usageLength(to - last.end), reason: `last: ${last.borrow.fork}, ${last.borrow.result} ${at(last.borrow.end)}` }
      : { reason: "last borrow unknown" }),
  };
}

function factsLine(model: Model, now: Date, context: CoreContext): string | undefined {
  const { stack } = model;
  const ready = deployableWords(model, now, context).figure;
  const latest = stack.lifecycle.smoke.runs.at(-1);
  const at = (run: NonNullable<typeof latest>) => environmentAt(run.updatedAt, now, context);
  const previous = stack.lifecycle.smoke.runs.at(-2);
  const rerun = latest?.status === "in_progress" && previous?.status === "completed" && runResult(previous) === "failed";
  const words = [
    stack.running?.version,
    ready ? `ready ${ready} of ${timeUnit(HISTORY_DAYS, "d")}` : undefined,
    rerun ? `smoke failed ${at(previous)}, rerunning`
      : latest ? `smoke ${runResult(latest)}${latest.status === "completed" ? ` ${at(latest)}` : ""}`
      : undefined,
  ].filter(Boolean).map((word) => word?.trim());
  return words.length ? words.join(" · ") : undefined;
}

const ACTIVITY_WORDS = Object.freeze({
  borrow: "borrow",
  borrows: "borrows",
  borrowed: "borrowed",
  maintenance: "maintenance",
  idle: "idle",
  overlap: "fork overlap",
  held: "In maintenance",
  estimated: "end estimated",
  estimatedNote: "End estimated.",
  unknown: "end unknown",
  missed: "missed nightly",
  byHand: "by hand",
});

type EnvActivitySegment = {
  kind: "maintenance" | "borrowed" | "estimated" | "overlap" | "idle";
  start: string;
  end: string;
  title?: string;
};

export type EnvActivity = {
  label: string;
  words: typeof ACTIVITY_WORDS;
  segments: EnvActivitySegment[];
};

function activityOf(borrows: readonly EnvBorrow[], lanes: readonly EnvLane[], from: number, to: number): EnvActivity {
  const windows = borrows.flatMap((borrow) => {
    const start = Date.parse(borrow.start);
    const end = borrow.result === "running" ? to : Date.parse(borrow.end ?? "");
    return end > from && start < to && end > start ? [{ borrow, start, end }] : [];
  });
  const holds = lanes.find(({ id }) => id === "holds")?.events.map(({ start, end }) => ({
    start: Date.parse(start),
    end: end === undefined ? to : Date.parse(end),
  })) ?? [];
  const edges = new Set([from, to]);
  for (const { start, end } of [...holds, ...windows]) {
    if (end <= from || start >= to || end <= start) continue;
    edges.add(Math.max(from, start));
    edges.add(Math.min(to, end));
  }
  const cuts = [...edges].sort((a, b) => a - b);
  const parts: (Interval & { kind: EnvActivitySegment["kind"]; forks: string[] })[] = [];
  let previous = from;
  for (const end of cuts.slice(1)) {
    const start = previous;
    previous = end;
    const held = holds.some((hold) => hold.start <= start && hold.end > start);
    const active = held ? [] : windows.filter((win) => win.start <= start && win.end > start);
    const measuredForks = distinct(active.filter(({ borrow }) => !borrow.estimated).map(({ borrow }) => borrow.fork));
    const kind = held ? "maintenance" : measuredForks.length > 1 ? "overlap"
      : measuredForks.length ? "borrowed" : active.length ? "estimated" : "idle";
    const forks = (measuredForks.length ? measuredForks : distinct(active.map(({ borrow }) => borrow.fork))).sort();
    const last = parts.at(-1);
    if (last?.kind === kind && (kind === "overlap" || last.forks.join() === forks.join())) {
      last.end = end;
      if (kind === "overlap") last.forks = distinct([...last.forks, ...forks]).sort();
    } else parts.push({ start, end, kind, forks });
  }
  const segments = parts.map(({ start, end, kind, forks }) => ({
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    kind,
    ...(forks.length ? { title: forks.join(kind === "overlap" ? " × " : ", ") } : {}),
  }));
  return { label: "Activity", words: ACTIVITY_WORDS, segments };
}

export function holdAttribution(runs: readonly LifecycleRun[], start: number, end?: number): string | undefined {
  const set = runs.filter((run) => replayHolds([run]).holds.some((hold) => hold.from === start));
  const clear = end === undefined ? [] : runs.filter((run) =>
    viewRun(run).stages.some((stage) =>
      stage.label === "clear" && stage.state === "ok" &&
      Date.parse(stage.completedAt ?? run.updatedAt) === end,
    ),
  );
  const name = ({ kind, target }: LifecycleRun) =>
    [kind.charAt(0).toUpperCase() + kind.slice(1), target].filter(Boolean).join(" ");
  const words = [
    set.length === 1 && set[0] ? `Likely set by ${name(set[0])}.` : undefined,
    clear.length === 1 && clear[0] ? `Likely cleared by ${name(clear[0])}.` : undefined,
  ].filter(Boolean);
  return words.length ? words.join(" ") : undefined;
}

export function environmentUsage(
  model: Model, lanes: readonly EnvLane[], from: number, now: Date, context: CoreContext,
) {
  const to = now.getTime();
  const all = borrowList(model.forkDeployments, now, context);
  const forksNote = incompleteNote(model.forkDeployments, from);
  const status = statusOf(model, lanes, all, forksNote, now, context);
  const borrows = all.filter((borrow) =>
    (borrow.result === "running" ? to : Date.parse(borrow.end ?? borrow.start)) >= from,
  ).map((borrow) => {
    const overlap = overlapOf(borrow, all, to);
    return overlap ? { ...borrow, overlap } : borrow;
  });
  const line = status.state === "maintenance" ? undefined : factsLine(model, now, context);
  const activity = activityOf(borrows, lanes, from, to);
  return { status, borrows, activity, ...(forksNote ? { forksNote } : {}), ...(line ? { line } : {}) };
}

const UNSCHEDULED: Readonly<Partial<Record<LifecycleKind, string>>> = Object.freeze({
  upgrade: "on version bump",
  reset: "by hand, weekly",
});
const RESET_DUE_DAYS = 7;

/** Where a finished run's bar ends: its last finished stage, else its last update. */
export function runEnd(view: RunView): string | undefined {
  if (view.run.status !== "completed") return undefined;
  const ends = view.stages.flatMap((s) => (s.completedAt ? [s.completedAt] : [])).sort();
  return ends.at(-1) ?? view.run.updatedAt;
}

type LastRun = { text: string; note?: string; late?: true };
type LaneLast = LastRun & { from: string; to: string };

/**
 * A lane's newest run before `before` when none falls in [before, to). At now, Reset adds
 * its age and Upgrade the release not yet adopted; a past day adds neither.
 */
export function lastRun(
  model: Model, kind: LifecycleKind, before: number, to: number, atNow: boolean, context: CoreContext,
): LastRun | undefined {
  const { stack } = model;
  const runs = stack.lifecycle[kind].runs;
  const endOf = (run: (typeof runs)[number]) => {
    const end = runEnd(viewRun(run));
    return end ? Date.parse(end) : to;
  };
  if (runs.some((run) => inRange(Date.parse(run.createdAt), endOf(run), before, to, atNow))) return undefined;
  const run = runs.filter((item) => Date.parse(item.createdAt) < before).at(-1);
  if (!run) return undefined;
  const date = wallClock(Date.parse(run.createdAt), context.timeZone ?? "UTC").date;
  const last: LastRun = { text: [run.target, date, runResult(run)].filter(Boolean).join(" \u00b7 ") };
  if (!atNow) return last;
  const age = Math.floor((to - endOf(run)) / DAY);
  const current = stack.declared ?? stack.running?.version;
  if (kind === "reset") {
    last.note = age === 0 ? "today" : `${age} ${age === 1 ? "day" : "days"} ago`;
    if (age > RESET_DUE_DAYS) last.late = true;
  } else if (kind === "upgrade" && stack.latest && current && semverCmp(stack.latest, current) > 0) {
    last.note = `${stack.latest} not adopted`;
  }
  return last;
}

/**
 * A lane's cadence, its last run when the 24-hour range has none, the same for 7 days and each of
 * its days, and the nightly slots missed.
 */
export function laneRhythm(
  model: Model, kind: LifecycleKind, from: number, now: Date, context: CoreContext,
): { cadence?: string; last?: LastRun; lasts?: LaneLast[]; missed?: string[] } {
  const { stack } = model;
  const to = now.getTime();
  const crons = stack.schedules?.[kind];
  const rhythm = crons && (crons.length ? cadence(crons, now, context.timeZone ?? "UTC") : UNSCHEDULED[kind]);
  const last = lastRun(model, kind, to - DAY, to, true, context);
  const days = localDays(from, to, context).map(({ start }) => start);
  const ranges: [number, number][] = [[from, to], ...days.map((start, index): [number, number] => [start, days[index + 1] ?? to])];
  const lasts = ranges.flatMap(([start, end]) => {
    const found = lastRun(model, kind, start, end, end === to, context);
    return found ? [{ from: new Date(start).toISOString(), to: new Date(end).toISOString(), ...found }] : [];
  });
  const smoke = kind === "smoke" && !stack.unread.includes("smoke") && crons;
  const kept = stack.retainedFrom?.smoke;
  const listed = kept === undefined ? to : kept === null ? from : Math.min(to, Date.parse(kept));
  const missed = smoke
    ? firesBetween(crons, from, listed - MISSED_AFTER_MS).filter((slot) =>
        !stack.lifecycle.smoke.runs.some((run) => {
          const start = Date.parse(run.createdAt);
          return run.event === "schedule" && start >= slot && start - slot <= MISSED_AFTER_MS;
        })).map((slot) => new Date(slot).toISOString())
    : [];
  return {
    ...(rhythm ? { cadence: rhythm } : {}),
    ...(last ? { last } : {}),
    ...(lasts.length ? { lasts } : {}),
    ...(missed.length ? { missed } : {}),
  };
}
