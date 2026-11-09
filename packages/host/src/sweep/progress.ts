// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { type SweepProgress, SweepProgressSchema, type SweepReasonCode } from "@spi-code/contracts";
import type { CollectorOptions } from "@spi-code/core";
import type { SweepTimers } from "./service.js";

type CoreProgress = Parameters<NonNullable<CollectorOptions["progress"]>>[0];

const sources = [
  "auth",
  "fleet",
  "github",
  "runs",
  "approvals",
  "lifecycle",
  "template",
  "details",
  "upstream",
  "radar",
  "security",
  "releases",
] as const;

const reasons: Record<SweepReasonCode, string> = {
  signin: "A tool needs sign-in or access. Open Settings to check Readiness.",
  budget: "This source waits for GitHub budget.",
  throttled: "GitHub asked SPI Code to slow down.",
  cadence: "This source is not due yet.",
  limit: "Some reads reached a page or size limit.",
  unavailable: "The source is unavailable.",
  timeout: "The read ran out of time.",
  save: "SPI Code could not save the sweep.",
  other: "SPI Code could not complete the read.",
};

export function safeSweepReason(code: SweepReasonCode): string {
  return reasons[code];
}

/** Core's completeness is item counts; only its cut outcome supplies incomplete read counts. */
export function foldSweepProgress(current: SweepProgress, event: CoreProgress): unknown {
  if (event.kind === "failed" || current.outcome !== "running") return current;
  const previous = current.sources.find((entry) => entry.source === event.source);
  if (!previous) return undefined;
  const startedAt = previous && "startedAt" in previous ? previous.startedAt : undefined;
  const started = startedAt === undefined ? {} : { startedAt };
  let source: Record<string, unknown>;
  if (event.kind === "throttle" || event.state === "throttled") {
    const code = event.code ?? "throttled";
    source = {
      source: event.source,
      state: "throttled",
      ...started,
      code,
      reason: safeSweepReason(code),
      resumeAt: event.resumeAt,
    };
  } else if (event.state === "reading") {
    source = { source: event.source, state: "reading", startedAt: event.startedAt };
  } else {
    const ended = { source: event.source, ...started, endedAt: event.endedAt };
    const code =
      event.code ??
      (event.state === "cut"
        ? "limit"
        : event.state === "skipped"
          ? "cadence"
          : event.state === "deferred"
            ? "budget"
            : "other");
    const reason = safeSweepReason(code);
    switch (event.state) {
      case "read":
        source = { ...ended, state: "read" };
        break;
      case "cut":
        source = { ...ended, state: "cut", code, reason, incomplete: event.incomplete };
        break;
      case "deferred":
        source = {
          ...ended,
          state: "deferred",
          code,
          reason,
          ...(event.resumeAt === undefined ? {} : { resumeAt: event.resumeAt }),
        };
        break;
      case "skipped":
        source = { ...ended, state: "skipped", code, reason };
        break;
      case "failed":
        source = { ...ended, state: "failed", code, reason };
        break;
    }
  }
  return {
    ...current,
    sources: current.sources.map((entry) => (entry.source === event.source ? source : entry)),
  };
}

export class SweepProgressFeed {
  latest: SweepProgress | undefined;
  failureCode: SweepReasonCode | undefined;
  private source: string | undefined;
  private pending = false;
  private cancel: (() => void) | undefined;

  constructor(
    private readonly options: {
      now: () => number;
      timers: SweepTimers;
      send?: ((progress: SweepProgress) => void) | undefined;
      onError: (error: unknown) => void;
    },
  ) {}

  begin(first: boolean, usualMs: number | null): void {
    this.source = undefined;
    this.failureCode = undefined;
    this.update({
      sweep: randomUUID(),
      startedAt: new Date(this.options.now()).toISOString(),
      first,
      usualMs,
      outcome: "running",
      nextAttemptAt: null,
      sources: sources.map((source) => ({ source, state: "waiting" })),
    });
  }

  report(event: CoreProgress): void {
    if (this.latest?.outcome !== "running") return;
    if (event.kind === "failed") {
      this.failureCode = event.code;
      return;
    }
    const next = foldSweepProgress(this.latest, event);
    if (this.update(next)) this.source = event.source;
  }

  finish(
    outcome: "committed" | "cancelled" | "failed",
    nextAttemptAt: string | null,
    code: SweepReasonCode = this.failureCode ?? "other",
  ): void {
    if (!this.latest) return;
    const { sweep, startedAt, first, usualMs, sources } = this.latest;
    const state = { sweep, startedAt, first, usualMs, sources };
    this.update(
      outcome === "failed"
        ? {
            ...state,
            outcome,
            nextAttemptAt,
            code,
            failure: safeSweepReason(code),
            ...(code === "save" || this.source === undefined ? {} : { source: this.source }),
          }
        : { ...state, outcome, nextAttemptAt: null },
    );
  }

  private update(value: unknown): boolean {
    const parsed = SweepProgressSchema.safeParse(value);
    if (!parsed.success) {
      this.log(new Error("Dropped invalid sweep progress report"));
      return false;
    }
    this.latest = parsed.data;
    this.pending = true;
    if (this.options.send && !this.cancel) {
      this.flush();
    }
    return true;
  }

  private flush(): void {
    if (!this.latest) return;
    this.pending = false;
    this.cancel = this.options.timers.after(250, () => {
      this.cancel = undefined;
      if (this.pending) this.flush();
    });
    try {
      this.options.send?.(this.latest);
    } catch (error) {
      this.log(error);
    }
  }

  private log(error: unknown): void {
    try {
      this.options.onError(error);
    } catch {
      console.error("Sweep progress error sink failed");
    }
  }
}
