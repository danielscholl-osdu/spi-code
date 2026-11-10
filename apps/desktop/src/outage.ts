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
type SigninTool = NonNullable<ReturnType<typeof signedOutTool>>;

interface Signin {
  sources: ReadonlySet<string>;
  failures: (string | null)[];
  tool: SigninTool | null;
}

/** One outage: a lost sign-in, a stall, or both; it shows one banner, whichever is first told. */
interface Outage {
  notified: boolean;
  banner?: Notification;
  shown?: "signin" | "stalled";
  stalled: boolean;
  signin: Signin | null;
}

export interface OutageOptions {
  focused(): boolean;
  open(destination: WindowDestination): void;
  power: PowerEvents;
  stallMs?: number;
}

/**
 * One "can't read the program" banner per outage (PS-19): (a) a source that read earlier in this
 * run now fails for sign-in, or (b) no sweep commits for 15 awake minutes. A commit ends a stall; a
 * lost sign-in ends when its source reads again or setup reports its tool signed back in. Held in
 * memory for this app run; skipped, and retried later, while the window is focused.
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
  let cursor: number | null = null;
  let lastFailure: string | null = null;
  let retryMs = RETRY_MS;
  let outage: Outage | null = null;
  let stall: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  /** After a wake, an outage waits for the next sweep to end, so the wake sweep can commit first. */
  let waking = false;
  let disposed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const tell = (current: Outage): { shown: "signin" | "stalled"; text: string } | null => {
    const tool = current.signin?.tool;
    if (tool) {
      const text =
        sweptAt === null
          ? `${tool} is signed out.`
          : `${tool} is signed out. Today is from ${clockTime(sweptAt)}.`;
      return { shown: "signin", text };
    }
    if (!current.stalled || sweptAt === null) return null;
    const since = `No sweep has finished since ${clockTime(sweptAt)}.`;
    const reason = lastFailure === null ? "" : notificationText(lastFailure, 120);
    if (!reason) return { shown: "stalled", text: since };
    const last = /[.!?]$/.test(reason) ? reason : `${reason}.`;
    return { shown: "stalled", text: `${since} Last: ${last}` };
  };

  const deliver = () => {
    const current = outage;
    if (current === null || current.notified || waking || !Notification.isSupported()) return;
    const told = tell(current);
    if (told === null) return;
    if (focused()) {
      retry ??= setTimeout(() => {
        retry = undefined;
        deliver();
      }, retryMs);
      return;
    }
    clearTimeout(retry);
    retry = undefined;
    const notification = new Notification({ title: TITLE, body: told.text });
    current.notified = true;
    current.shown = told.shown;
    current.banner = notification;
    const destination: WindowDestination =
      told.shown === "signin" ? { to: "readiness" } : { to: "evidence" };
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

  const attribute = () => {
    const signin = outage?.signin;
    if (signin) signin.tool = signedOutTool(signin.failures, tools) ?? signin.tool;
  };

  /** The lost sign-in is back; a stall that outlives it stays the same outage until a commit. */
  const recovered = () => {
    if (outage === null) return;
    if (!outage.stalled) return end();
    outage.signin = null;
    if (outage.shown === "signin") outage.banner?.close();
  };

  const stalled = () => {
    stall = undefined;
    waking = false;
    outage ??= { notified: false, stalled: false, signin: null };
    outage.stalled = true;
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
    if (outage === null) return;
    if (outage.signin === null) return end();
    outage.stalled = false;
    if (outage.shown === "stalled") outage.banner?.close();
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
    if (progress.outcome === "committed") committed();
    else if (progress.outcome === "failed") lastFailure = progress.failure;
    const signin = outage?.signin;
    if (signin) {
      const back = progress.sources.some(
        ({ source, state }) => signin.sources.has(source) && (state === "read" || state === "cut"),
      );
      if (back && ![...signin.sources].some((source) => failing.has(source))) recovered();
      else if (failures.length > 0) signin.failures = failures;
    }
    if (!outage?.signin) {
      const lost = failures.filter(
        (source): source is string => source !== null && readable.get(source) === true,
      );
      if (lost.length > 0) {
        outage ??= { notified: false, stalled: false, signin: null };
        outage.signin = { sources: new Set(lost), failures, tool: null };
      }
    }
    for (const source of progress.sources) {
      if (source.state === "read" || source.state === "cut") readable.set(source.source, true);
      else if (source.state === "failed") readable.set(source.source, false);
    }
    if (progress.outcome === "failed" && progress.source !== undefined) {
      readable.set(progress.source, false);
    }
    waking = false;
    attribute();
    deliver();
  };

  const slept = () => {
    clearTimeout(stall);
    stall = undefined;
    clearTimeout(retry);
    retry = undefined;
  };
  const woke = () => {
    waking = true;
    clearTimeout(retry);
    retry = undefined;
    if (armed) watchFrom();
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
        const before = tools;
        tools = new Map(message.payload.tools.map(({ tool, state }) => [tool, state]));
        const tool = outage?.signin?.tool;
        if (tool && before.get(tool) === "signed-out" && tools.get(tool) === "ready") recovered();
        attribute();
        deliver();
      } else if (message.type === "view.snapshot") {
        const previous = cursor;
        cursor = message.payload.cursor;
        sweptAt = message.payload.sweptAt;
        if (previous === null) watchFrom();
        else if (cursor > previous) committed();
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
