// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { timeUnit } from "@spi-code/contracts";
import { when } from "@spi-code/contracts";
import { HISTORY_DAYS } from "../config.js";
import type { CoreContext } from "../context.js";
import type { DeploymentFact } from "../facts.js";
import { median } from "../model/history.js";
import type { ForkDeployments, Model } from "../model/index.js";
import { runResult } from "../model/stack.js";
import { span, stamp } from "../util.js";
import type { EnvLane, Link } from "./index.js";
import { deployableWords } from "./words.js";

export interface EnvBorrow {
  id: string;
  fork: string;
  branch?: string;
  result: "green" | "failed" | "running" | "unknown";
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

export function environmentFrom(now: Date, context: CoreContext): number {
  if (context.words !== "app") return now.getTime() - DAY;
  const dateKey = new Intl.DateTimeFormat("sv-SE", {
    timeZone: context.timeZone ?? "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format;
  const localDay = Date.parse(dateKey(now));
  const midnight = localDay - 6 * DAY;
  let lo = midnight - DAY;
  let hi = midnight + DAY;
  // Search for the first instant of the target local date, including a midnight clock change.
  const target = new Date(midnight).toISOString().slice(0, 10);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateKey(mid) < target) lo = mid;
    else hi = mid;
  }
  return hi;
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

function borrowList(histories: readonly ForkDeployments[], to: number): EnvBorrow[] {
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
      return {
        id: `${fork}:${deploy.id ?? `${deploy.createdAt}:${deploy.sha ?? ""}:${index}`}`,
        fork,
        ...(deploy.ref ? { branch: deploy.ref } : {}),
        result: result(deploy.state),
        start: new Date(start).toISOString(),
        ...(end !== undefined ? { end: new Date(end).toISOString() } : {}),
        ...(estimate !== undefined ? { estimated: true } : {}),
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
    const what = run?.kind === "upgrade" ? "Upgrade" : "Refresh";
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

export function environmentUsage(
  model: Model, lanes: readonly EnvLane[], from: number, now: Date, context: CoreContext,
) {
  const to = now.getTime();
  const all = borrowList(model.forkDeployments, to);
  const forksNote = incompleteNote(model.forkDeployments, from);
  const status = statusOf(model, lanes, all, forksNote, now, context);
  const borrows = all.filter((borrow) =>
    (borrow.result === "running" ? to : Date.parse(borrow.end ?? borrow.start)) >= from,
  ).map((borrow) => {
    const overlap = overlapOf(borrow, all, to);
    return overlap ? { ...borrow, overlap } : borrow;
  });
  const line = status.state === "maintenance" ? undefined : factsLine(model, now, context);
  return { status, borrows, ...(forksNote ? { forksNote } : {}), ...(line ? { line } : {}) };
}
