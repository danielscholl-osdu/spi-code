// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope, SweepStatus } from "@spi-code/contracts";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { isMacPlatform } from "../app/shortcuts.js";
import { plain, sourceName, sweepSources } from "../components/evidence/words.js";
import { duration, outcomeLine, sourceOutcome } from "../components/sweep/words.js";
import { watchStore } from "../store/watch.js";
import { clockTime, timeUnit } from "../time.js";

type Cadence = keyof SweepStatus["schedule"];

/** What a sweep reads, grouped by how often each source is due, in the decision's order. */
export const SWEEP_READS: readonly { sources: readonly string[]; cadence: Cadence }[] = [
  {
    sources: ["auth", "fleet", "github", "runs", "approvals", "lifecycle", "template", "details"],
    cadence: "sweepMs",
  },
  { sources: ["upstream", "radar"], cadence: "gitlabMs" },
  { sources: ["security"], cadence: "securityMs" },
  { sources: ["releases"], cadence: "releasesMs" },
];

const HOUR = 3_600_000;

function often(ms: number, schedule: SweepStatus["schedule"]): string {
  if (ms === schedule.sweepMs) return "every sweep";
  if (ms === HOUR) return "every hour";
  if (ms % HOUR === 0) return `every ${timeUnit(ms / HOUR, "h")}`;
  return `every ${timeUnit(Math.round(ms / 60_000), "min")}`;
}

function minutes(ms: number): string {
  const count = Math.round(ms / 60_000);
  return `${count}\u00a0${count === 1 ? "minute" : "minutes"}`;
}

/** The oldest read among a group's sources, so the row never claims more than its stalest source. */
function lastRead(envelopes: ReadonlyMap<string, Envelope>, sources: readonly string[]) {
  const times = sources.flatMap((source) => {
    const envelope = envelopes.get(source);
    return envelope && "observedAt" in envelope && envelope.observedAt ? [envelope.observedAt] : [];
  });
  return times.length === 0
    ? null
    : (times.reduce((oldest, at) => (Date.parse(at) < Date.parse(oldest) ? at : oldest)) ?? null);
}

/** setTimeout's longest delay; a longer one fires at once. */
const LONGEST_DELAY = 2_147_483_647;

/**
 * The wall clock, ticking every 15 s and again at each shown future time, so no time stays on
 * screen as a promise once it has passed.
 */
function useClock(deadlines: readonly (string | null | undefined)[]): number {
  const [now, setNow] = useState(() => Date.now());
  const key = deadlines.join("|");
  useEffect(() => {
    const times = key
      .split("|")
      .map((at) => Date.parse(at))
      .filter(Number.isFinite);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const current = Date.now();
      setNow(current);
      const ahead = times.filter((at) => at > current);
      if (ahead.length > 0)
        timer = setTimeout(arm, Math.min(Math.min(...ahead) - current, LONGEST_DELAY));
    };
    arm();
    const tick = setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, [key]);
  return now;
}

/**
 * A deferred area in Evidence's words: a budget deferral waits for GitHub budget, after the reset
 * only while that is still ahead; any other waits for the next sweep with its reason.
 */
function deferredLine(area: string, reason: string, reset: string | null, now: number): string {
  const said = plain(reason);
  if (!/\bbudget\b/.test(said)) return `waits for the next sweep · ${said}`;
  const outcome = sourceOutcome(
    {
      source: area,
      state: "deferred",
      code: "budget",
      reason: said,
      ...(reset ? { resumeAt: reset } : {}),
    },
    now,
  );
  return outcomeLine(outcome, now);
}

function Clock({ at, now, hint = true }: { at: string; now: number; hint?: boolean }) {
  return <time dateTime={at}>{clockTime(at, { now, hint })}</time>;
}

/**
 * Settings → Sweep (ST-07): the schedule, what a sweep reads, the GitHub budget and the
 * notifications note. Cadences are fixed; Sweep now in the header is the only control.
 */
export function SweepSection({ store = watchStore }: { store?: typeof watchStore }) {
  const sweep = useStore(store, (state) => state.sweep);
  const progress = useStore(store, (state) => state.progress);
  const completed = useStore(store, (state) => state.completed);
  const snapshot = useStore(store, (state) => state.snapshot);
  const now = useClock([sweep?.nextSweepAt, sweep?.resetAt]);
  const last = sweep?.lastSweep ?? null;
  const next =
    snapshot && sweep?.nextSweepAt && Date.parse(sweep.nextSweepAt) > now
      ? sweep.nextSweepAt
      : null;
  // The last sweep's own progress: still current, or kept as completed once the next one starts.
  const ended = last ? [progress, completed].find((entry) => entry?.sweep === last.sweep) : null;
  const failures =
    ended?.sources.filter(
      (source) =>
        source.state === "failed" || (source.state === "cut" && !!source.incomplete.failed),
    ).length ?? 0;
  const outcome =
    last?.outcome !== "committed"
      ? "stopped"
      : failures > 0
        ? `${failures} ${failures === 1 ? "source" : "sources"} failed`
        : "saved";
  const reset = sweep?.resetAt && Date.parse(sweep.resetAt) > now ? sweep.resetAt : null;
  const low =
    sweep?.remaining != null && sweep.floor !== undefined && sweep.remaining < sweep.floor;
  const envelopes = new Map(
    snapshot ? sweepSources(snapshot.body).map(({ key, envelope }) => [key, envelope]) : [],
  );
  const wakes = isMacPlatform() ? "this Mac" : "Windows";
  return (
    <div className="sweep-settings">
      <h2 className="readiness-group-title">Schedule</h2>
      <dl className="sweep-summary">
        <dt>Last sweep</dt>
        <dd>
          {last ? (
            <>
              <Clock at={last.endedAt} now={now} hint={false} />
              {` · took ${duration(Date.parse(last.endedAt) - Date.parse(last.startedAt))} · ${outcome}`}
            </>
          ) : (
            "none since SPI Code opened"
          )}
        </dd>
        {next && (
          <>
            <dt>Next sweep</dt>
            <dd>
              <Clock at={next} now={now} />
            </dd>
          </>
        )}
      </dl>
      <p className="sweep-prose">
        A sweep starts {sweep ? `every ${minutes(sweep.schedule.sweepMs)}` : "on a fixed timer"}{" "}
        while SPI Code is open, and when {wakes} wakes. The top row's "next sync" is the forks'
        upstream sync, not a sweep.
      </p>
      <h2 className="readiness-group-title">What a sweep reads</h2>
      <table className="sweep-reads">
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">How often</th>
            <th scope="col">Last read</th>
          </tr>
        </thead>
        <tbody>
          {SWEEP_READS.map(({ sources, cadence }) => {
            const read = lastRead(envelopes, sources);
            return (
              <tr key={cadence}>
                <td>{sources.map(sourceName).join(", ")}</td>
                <td>{sweep ? often(sweep.schedule[cadence], sweep.schedule) : "—"}</td>
                <td>
                  <span className="mobile-label">last read </span>
                  {read ? <Clock at={read} now={now} hint={false} /> : "not read yet"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2 className="readiness-group-title">GitHub budget</h2>
      <div className="sweep-prose sweep-budget">
        <p role={low ? "alert" : undefined} data-low={low || undefined}>
          {sweep?.remaining == null ? (
            "GitHub budget not reported yet."
          ) : (
            <>
              {`${sweep.remaining.toLocaleString("en-US")} points left`}
              {low && " · below the floor"}
              {reset && (
                <>
                  {" · resets "}
                  <Clock at={reset} now={now} />
                </>
              )}
            </>
          )}
        </p>
        <p>
          {sweep?.floor === undefined
            ? "The budget floor is not reported by the host."
            : `Below ${sweep.floor.toLocaleString("en-US")} points, GitHub reads wait for the reset so sweeps never spend what your own gh use needs.`}
        </p>
        {sweep?.deferredAreas.map(({ area, reason }) => (
          <p key={area}>
            {sourceName(area)} {deferredLine(area, reason, reset, now)}
          </p>
        ))}
      </div>
      <h2 className="readiness-group-title">Notifications</h2>
      <p className="sweep-prose">
        SPI Code tells you when a sweep finds something new that needs you, or when it can no longer
        read the program. Routine sweeps are quiet. Your system's notification settings control
        sound and quiet hours.
      </p>
    </div>
  );
}
