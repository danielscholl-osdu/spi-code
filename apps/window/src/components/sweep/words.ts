// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SweepProgress, SweepReasonCode, SweepSourceProgress } from "@spi-code/contracts";
import { clockTime, timeUnit } from "../../time.js";

export type SourceTone = "wait" | "run" | "ok" | "warn" | "bad";

export function readinessCanFix(code: SweepReasonCode | undefined): boolean {
  return code === "signin";
}

/** An elapsed time in whole seconds: `22 s`, `1 min 10 s`, `1 h 2 min`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return timeUnit(seconds, "s");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${timeUnit(minutes, "min")}${seconds % 60 ? ` ${timeUnit(seconds % 60, "s")}` : ""}`;
  return `${timeUnit(Math.floor(minutes / 60), "h")}${minutes % 60 ? ` ${timeUnit(minutes % 60, "min")}` : ""}`;
}

/** A usual sweep length, rounded: `40 s`, `2 min`. */
export function about(ms: number): string {
  return ms < 60_000
    ? timeUnit(Math.max(1, Math.round(ms / 1000)), "s")
    : timeUnit(Math.round(ms / 60_000), "min");
}

/** A clock time the copy already places: no relative hint. */
export function at(time: string, now: number): string {
  return clockTime(time, { now, hint: false });
}

/** The outcome line as it reads, with its time in clock words. */
export function outcomeLine({ text, after }: SourceOutcome, now: number): string {
  return after ? `${text} · after ${at(after, now)}` : text;
}

const SETTLED: ReadonlySet<SweepSourceProgress["state"]> = new Set([
  "read",
  "cut",
  "deferred",
  "skipped",
  "failed",
]);

export function settled(progress: SweepProgress): number {
  return progress.sources.filter(({ state }) => SETTLED.has(state)).length;
}

export function failedCount(progress: SweepProgress): number {
  return progress.sources.filter(({ state }) => state === "failed").length;
}

/** When the sweep stopped moving: now while it runs, else its last source's end. */
export function sweepEnd(progress: SweepProgress, now: number): number {
  if (progress.outcome === "running") return now;
  const marks = progress.sources.flatMap((source) => [
    ...(source.state !== "waiting" && source.startedAt ? [Date.parse(source.startedAt)] : []),
    ...("endedAt" in source && source.endedAt ? [Date.parse(source.endedAt)] : []),
  ]);
  return marks.length > 0 ? Math.max(...marks) : now;
}

export type SourceOutcome = {
  mark: string;
  tone: SourceTone;
  text: string;
  /** The ISO instant the copy follows with " · after HH:MM". */
  after?: string;
  why?: string;
  detail?: string;
  code?: SweepReasonCode;
};

/** A source's mark, tone and outcome line in the first sweep's words. */
export function sourceOutcome(source: SweepSourceProgress, now: number): SourceOutcome {
  const took = (startedAt?: string, endedAt?: string) =>
    startedAt && endedAt ? ` · ${duration(Date.parse(endedAt) - Date.parse(startedAt))}` : "";
  switch (source.state) {
    case "waiting":
      return { mark: "○", tone: "wait", text: "waiting" };
    case "reading":
    case "throttled": {
      if (!source.startedAt) return { mark: "◐", tone: "run", text: "reading" };
      const ms = Math.max(0, now - Date.parse(source.startedAt));
      return {
        mark: "◐",
        tone: "run",
        text: `${ms > 60_000 ? "still reading" : "reading"} · ${duration(ms)}`,
      };
    }
    case "read":
      return { mark: "✓", tone: "ok", text: `read${took(source.startedAt, source.endedAt)}` };
    case "cut": {
      const { count, total, failed = 0 } = source.incomplete;
      const kind = { "job-log": "job log", diff: "diff", "run-list": "run list", read: "read" }[
        source.cutKind ?? "read"
      ];
      const complete = total - count - failed;
      const parts = [
        ...(count > 0 ? [`${count} ${kind}${count === 1 ? "" : "s"} cut short`] : []),
        ...(failed > 0 ? [`${failed} ${failed === 1 ? "read" : "reads"} failed`] : []),
        ...(failed === 0 && complete > 0 ? ["rest read"] : []),
      ];
      return {
        mark: "⚠",
        tone: "warn",
        text: `read${took(source.startedAt, source.endedAt)} · ${parts.join("; ")}`,
        detail: `${complete} of ${total} ${total === 1 ? "read" : "reads"} complete.${source.reason ? ` ${source.reason}` : ""}`,
        ...(source.failure ? { why: source.failure } : {}),
      };
    }
    case "deferred": {
      const after = source.resumeAt ? { after: source.resumeAt } : {};
      return source.code === "budget"
        ? { mark: "–", tone: "warn", text: "waits for GitHub budget", ...after }
        : { mark: "–", tone: "warn", text: "put off", ...after, why: source.reason };
    }
    case "skipped":
      return { mark: "–", tone: "warn", text: "skipped" };
    case "failed":
      return { mark: "✕", tone: "bad", text: "failed", why: source.reason, code: source.code };
  }
}
