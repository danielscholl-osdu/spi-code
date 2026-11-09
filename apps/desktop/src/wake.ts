// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { type Message, PROTOCOL_VERSION, parseMessage } from "@spi-code/contracts";

/** How long after a wake desktop main waits before asking for a sweep (ST-07). */
export const WAKE_DELAY_MS = 15_000;

const OBSERVED = new Set(["sweep.status", "view.snapshot", "setup.state"]);

type WakeEvent = "resume" | "unlock-screen" | "suspend";

/** The part of Electron's powerMonitor a wake sweep listens to. */
export interface PowerEvents {
  on(event: WakeEvent, listener: () => void): unknown;
  off(event: WakeEvent, listener: () => void): unknown;
}

export interface WakeSweepOptions {
  now?: () => number;
  delayMs?: number;
}

/**
 * Asks the host for a non-forced sweep once, 15 s after the machine resumes or unlocks, when the
 * last sweep is older than the host's sweep interval. Nothing is asked while the interval or the
 * last sweep is unknown: before the first snapshot the first sweep is already running.
 */
export function wakeSweep(
  power: PowerEvents,
  request: (message: Message) => boolean,
  { now = Date.now, delayMs = WAKE_DELAY_MS }: WakeSweepOptions = {},
) {
  let intervalMs: number | null = null;
  let lastSweepAt: number | null = null;
  let sweptAt: number | null = null;
  let watchReady = true;
  let pending: ReturnType<typeof setTimeout> | undefined;

  const due = () => {
    if (intervalMs === null || !watchReady) return false;
    const last = Math.max(
      lastSweepAt ?? Number.NEGATIVE_INFINITY,
      sweptAt ?? Number.NEGATIVE_INFINITY,
    );
    return Number.isFinite(last) && now() - last > intervalMs;
  };
  const fire = () => {
    pending = undefined;
    if (!due()) return;
    const sent = request({
      version: PROTOCOL_VERSION,
      id: randomUUID(),
      kind: "request",
      type: "sweep.request",
      payload: {},
    });
    if (!sent) console.warn("The wake sweep could not reach the host");
  };
  const woke = () => {
    if (pending === undefined) pending = setTimeout(fire, delayMs);
  };
  const cancel = () => {
    clearTimeout(pending);
    pending = undefined;
  };
  power.on("resume", woke);
  power.on("unlock-screen", woke);
  power.on("suspend", cancel);

  return {
    observe(input: unknown) {
      const type =
        typeof input === "object" && input !== null && "type" in input ? input.type : undefined;
      if (typeof type !== "string" || !OBSERVED.has(type)) return;
      const parsed = parseMessage(input);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (message.type === "sweep.status") {
        intervalMs = message.payload.schedule.sweepMs;
        const last = message.payload.lastSweep;
        lastSweepAt = last ? Date.parse(last.endedAt) : null;
      } else if (message.type === "view.snapshot") {
        sweptAt = Date.parse(message.payload.sweptAt);
      } else if (message.type === "setup.state") {
        watchReady = message.payload.watchReady;
      }
    },
    pending: () => pending !== undefined,
    dispose() {
      cancel();
      power.off("resume", woke);
      power.off("unlock-screen", woke);
      power.off("suspend", cancel);
    },
  };
}
