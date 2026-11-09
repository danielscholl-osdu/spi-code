// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { blocksWatch } from "@spi-code/contracts";
import { useEffect, useId, useState } from "react";
import { useStore } from "zustand";
import { hasSweepSnapshot, watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { settled } from "./words.js";
import "./sweep.css";

function useSweepClock(cooldown: number | null | undefined, next: string | null | undefined) {
  const [, setTick] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      setTick(now);
      const future = [cooldown, next ? Date.parse(next) : null].filter(
        (at): at is number => at !== null && at !== undefined && at > now,
      );
      timer = setTimeout(tick, Math.min(30_000, ...future.map((at) => at - now)));
    };
    tick();
    return () => clearTimeout(timer);
  }, [cooldown, next]);
  return Date.now();
}

/** Shared by Settings and Evidence; the caller closes its surface before opening the sweep. */
export function SweepNow({
  store = watchStore,
  onViewSweep,
  onOpenReadiness,
}: {
  store?: typeof watchStore;
  onViewSweep(): void;
  onOpenReadiness(): void;
}) {
  const state = useStore(store);
  const { sweep, progress, snapshot, sweepRequest, sweepRequestError, setup } = state;
  const now = useSweepClock(sweep?.forceCooldownUntil, sweep?.nextSweepAt);
  const statusId = useId();
  const disconnected = sweep === null;
  const notReady = !setup?.watchReady || setup.tools.some(blocksWatch);
  const running = progress?.outcome === "running" ? progress : null;
  const last = sweep?.lastSweep;
  const requested = last?.requested ? last : null;
  const saved =
    requested?.outcome === "committed" &&
    progress?.sweep === requested.sweep &&
    progress.outcome === "committed" &&
    hasSweepSnapshot(snapshot, requested);
  const waitingForSnapshot = requested?.outcome === "committed" && !saved;
  const cooldown = (sweep?.forceCooldownUntil ?? 0) > now;
  const disabled =
    disconnected || notReady || !!running || !!sweepRequest || waitingForSnapshot || cooldown;
  const label =
    running && !disconnected
      ? `${snapshot === null ? "First sweep running" : "Sweeping"} · ${settled(running)} of ${running.sources.length}`
      : "Sweep now";
  const next =
    snapshot && sweep?.nextSweepAt && Date.parse(sweep.nextSweepAt) > now
      ? sweep.nextSweepAt
      : null;
  const failures =
    progress && requested && progress.sweep === requested.sweep
      ? progress.sources.filter(
          (source) =>
            source.state === "failed" || (source.state === "cut" && !!source.incomplete.failed),
        ).length
      : 0;
  const view = (live = false) => (
    <button type="button" className="sweep-now-view" onClick={onViewSweep}>
      {live ? "View live sweep →" : "View sweep →"}
    </button>
  );
  const feedback = disconnected ? (
    "Reconnecting to the host."
  ) : notReady ? (
    <>
      Watch is not ready.{" "}
      <button type="button" className="sweep-now-readiness" onClick={onOpenReadiness}>
        Open Readiness.
      </button>
    </>
  ) : running ? (
    view(true)
  ) : waitingForSnapshot ? (
    "Waiting for saved sweep."
  ) : sweepRequest ? (
    "Requesting sweep."
  ) : requested && saved ? (
    <>
      Sweep saved at{" "}
      <time dateTime={requested.endedAt}>{clockTime(requested.endedAt, { now, hint: false })}</time>
      {failures > 0 ? ` · ${failures} ${failures === 1 ? "source" : "sources"} failed. ` : "."}
      {failures > 0 && view()}
    </>
  ) : requested && requested.outcome !== "committed" ? (
    <>
      Sweep stopped.{" "}
      {next && (
        <>
          Next attempt at <time dateTime={next}>{clockTime(next, { now, hint: false })}</time>.{" "}
        </>
      )}
      {view()}
    </>
  ) : null;
  return (
    <div className="sweep-now">
      <button
        type="button"
        disabled={disabled}
        title={cooldown ? "A sweep just ran." : undefined}
        aria-describedby={statusId}
        onClick={async () => {
          try {
            await store.getState().requestSweepNow();
          } catch {
            // The store reports send failures without exposing transport details.
          }
        }}
      >
        {label}
      </button>
      <div id={statusId} role="status" className="sweep-now-status">
        {feedback && <p>{feedback}</p>}
        {!disconnected && sweep.remaining === null && <p>GitHub budget not reported yet.</p>}
      </div>
      {sweepRequestError && <p role="alert">{sweepRequestError}</p>}
    </div>
  );
}
