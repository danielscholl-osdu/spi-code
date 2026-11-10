// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type Message, parseMessage } from "@spi-code/contracts";
import { Notification } from "electron";
import { notificationText } from "./interrupts.js";
import { clockTime, signedOutTool, signinFailures, type ToolStates } from "./tray.js";
import type { PowerEvents } from "./wake.js";
import type { WindowDestination } from "./window-navigation.js";

/** How long the machine stays awake without a committed sweep before it is an outage: three intervals. */
export const STALL_MS = 15 * 60_000;
const RETRY_MS = 300_000;
const REMEMBERED_SWEEPS = 64;
const OBSERVED = new Set(["sweep.progress", "sweep.status", "view.snapshot", "setup.state"]);
const TITLE = "SPI Code can't read the program";

type Progress = Extract<Message, { type: "sweep.progress" }>["payload"];

type Outage = { notified: boolean; banner?: Notification } & (
  | { kind: "signin"; sources: ReadonlySet<string>; failures: (string | null)[] }
  | { kind: "stalled" }
);

export interface OutageOptions {
  focused(): boolean;
  open(destination: WindowDestination): void;
  power: PowerEvents;
  stallMs?: number;
}

/**
 * One "can't read the program" banner per outage (PS-19): (a) a source that read earlier in this
 * run now fails for sign-in, or (b) no sweep commits for 15 awake minutes. A committed sweep ends the
 * outage. Held in memory for this app run; skipped, and retried later, while the window is focused.
 */
export function createOutageNotifications({
  focused,
  open,
  power,
  stallMs = STALL_MS,
}: OutageOptions) {
  /** Each source's last finished state in this run: true when it read, false when it failed. */
  const readable = new Map<string, boolean>();
  const finished = new Set<string>();
  let tools: ToolStates = new Map();
  let sweptAt: string | null = null;
  let lastFailure: string | null = null;
  let retryMs = RETRY_MS;
  let outage: Outage | null = null;
  let stall: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const body = (current: Outage): string | null => {
    if (current.kind === "signin") {
      const tool = signedOutTool(current.failures, tools);
      if (tool === null) return null;
      return sweptAt === null
        ? `${tool} is signed out.`
        : `${tool} is signed out. Today is from ${clockTime(sweptAt)}.`;
    }
    if (sweptAt === null) return null;
    const since = `No sweep has finished since ${clockTime(sweptAt)}.`;
    if (lastFailure === null) return since;
    const reason = notificationText(lastFailure, 120);
    if (!reason) return since;
    return /[.!?]$/.test(reason) ? `${since} Last: ${reason}` : `${since} Last: ${reason}.`;
  };

  const deliver = () => {
    const current = outage;
    if (current === null || current.notified || !Notification.isSupported()) return;
    const text = body(current);
    if (text === null) return;
    if (focused()) {
      retry ??= setTimeout(() => {
        retry = undefined;
        deliver();
      }, retryMs);
      return;
    }
    clearTimeout(retry);
    retry = undefined;
    const notification = new Notification({ title: TITLE, body: text });
    current.notified = true;
    current.banner = notification;
    const destination: WindowDestination =
      current.kind === "signin" ? { to: "readiness" } : { to: "evidence" };
    const forget = () => {
      if (current.banner === notification) delete current.banner;
    };
    notification.on("click", () => {
      forget();
      open(destination);
    });
    notification.on("close", forget);
    notification.on("failed", () => {
      forget();
      console.warn("A can't-read notification could not be displayed");
    });
    notification.show();
  };

  const end = () => {
    outage?.banner?.close();
    outage = null;
    clearTimeout(retry);
    retry = undefined;
  };

  const stalled = () => {
    stall = undefined;
    outage ??= { kind: "stalled", notified: false };
    deliver();
  };

  /** Starts the awake window afresh: after a commit, on the first snapshot, or after a wake. */
  const watchFrom = () => {
    clearTimeout(stall);
    armed = true;
    stall = setTimeout(stalled, stallMs);
  };

  const committed = () => {
    lastFailure = null;
    watchFrom();
    if (outage?.kind === "stalled") end();
  };

  const finish = (progress: Progress) => {
    if (progress.outcome === "running" || progress.outcome === "cancelled") return;
    if (finished.has(progress.sweep)) return;
    finished.add(progress.sweep);
    if (finished.size > REMEMBERED_SWEEPS) {
      const [oldest] = finished;
      if (oldest !== undefined) finished.delete(oldest);
    }
    const failures = signinFailures(progress);
    const failing = new Set(failures);
    if (progress.outcome === "committed") {
      committed();
      if (outage?.kind === "signin" && ![...outage.sources].some((source) => failing.has(source))) {
        end();
      }
    } else if (progress.outcome === "failed") {
      lastFailure = progress.failure;
    }
    if (outage === null) {
      const lost = failures.filter(
        (source): source is string => source !== null && readable.get(source) === true,
      );
      if (lost.length > 0) {
        outage = { kind: "signin", notified: false, sources: new Set(lost), failures };
      }
    } else if (outage.kind === "signin" && failures.length > 0) {
      outage.failures = failures;
    }
    for (const source of progress.sources) {
      if (source.state === "read" || source.state === "cut") readable.set(source.source, true);
      else if (source.state === "failed") readable.set(source.source, false);
    }
    if (progress.outcome === "failed" && progress.source !== undefined) {
      readable.set(progress.source, false);
    }
    deliver();
  };

  const woke = () => {
    if (!armed) return;
    if (outage?.kind === "stalled" && !outage.notified) outage = null;
    watchFrom();
  };
  const slept = () => {
    clearTimeout(stall);
    stall = undefined;
    clearTimeout(retry);
    retry = undefined;
  };
  power.on("resume", woke);
  power.on("unlock-screen", woke);
  power.on("suspend", slept);

  return {
    observe(input: unknown) {
      const type =
        typeof input === "object" && input !== null && "type" in input ? input.type : undefined;
      if (disposed || typeof type !== "string" || !OBSERVED.has(type)) return;
      const parsed = parseMessage(input);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (message.type === "sweep.progress") {
        finish(message.payload);
      } else if (message.type === "sweep.status") {
        retryMs = message.payload.schedule.sweepMs;
      } else if (message.type === "setup.state") {
        tools = new Map(message.payload.tools.map(({ tool, state }) => [tool, state]));
        deliver();
      } else if (message.type === "view.snapshot") {
        const previous = sweptAt;
        sweptAt = message.payload.sweptAt;
        if (previous === null) watchFrom();
        else if (Date.parse(sweptAt) > Date.parse(previous)) committed();
      }
    },
    dispose() {
      disposed = true;
      end();
      slept();
      power.off("resume", woke);
      power.off("unlock-screen", woke);
      power.off("suspend", slept);
    },
  };
}
