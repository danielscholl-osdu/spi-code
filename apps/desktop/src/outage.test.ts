// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
  type Message,
  PROTOCOL_VERSION,
  type SweepSourceProgress,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  supported: true,
  notifications: [] as (EventEmitter & {
    options: { title: string; body: string };
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  })[],
}));
vi.mock("electron", () => ({
  Notification: class extends EventEmitter {
    static isSupported = () => native.supported;
    show = vi.fn();
    close = vi.fn(() => this.emit("close"));
    constructor(public options: { title: string; body: string }) {
      super();
      native.notifications.push(this);
    }
  },
}));

import { createOutageNotifications, STALL_MS } from "./outage.js";

const MINUTE = 60_000;
const TITLE = "SPI Code can't read the program";
/** Local wall-clock times, so HH:MM reads the same in every zone. */
const at = (hours: number, minutes: number) => new Date(2026, 10, 9, hours, minutes).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  native.supported = true;
  native.notifications.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(at(8, 3));
});
afterEach(() => vi.useRealTimers());

const event = (type: string, payload: unknown) =>
  ({ version: PROTOCOL_VERSION, id: `${type}-1`, kind: "event", type, payload }) as Message;

const fixture = ViewSnapshotSchema.parse(
  JSON.parse(
    readFileSync(new URL("../../../fixtures/watch/snapshot-59d6895.json", import.meta.url), "utf8"),
  ),
);
const snapshot = (sweptAt: number) => event("view.snapshot", { ...fixture, sweptAt: iso(sweptAt) });

function status(sweepMs = 5 * MINUTE) {
  return event("sweep.status", {
    remaining: null,
    resetAt: null,
    deferredAreas: [],
    nextSweepAt: null,
    schedule: { sweepMs, gitlabMs: 30 * MINUTE, securityMs: 30 * MINUTE, releasesMs: 60 * MINUTE },
    lastSweep: null,
  });
}

function setup(gh: "ready" | "signed-out", glab: "ready" | "signed-out" = "ready") {
  return event("setup.state", {
    tools: [
      { tool: "git", state: "ready", action: null },
      { tool: "gh", state: gh, action: gh === "ready" ? null : "signin" },
      { tool: "glab", state: glab, action: glab === "ready" ? null : "signin" },
    ],
    watchReady: gh === "ready",
    disabledReason: gh === "ready" ? null : "GitHub CLI is not ready.",
  });
}

type Spec = "read" | "cut" | "signin" | "skipped" | "deferred" | "throttled" | "timeout";
const stamp = iso(at(8, 0));
function source(name: string, spec: Spec): SweepSourceProgress {
  switch (spec) {
    case "read":
      return { source: name, state: "read" };
    case "cut":
      return { source: name, state: "cut", incomplete: { count: 1, total: 4 }, cutKind: "read" };
    case "skipped":
      return { source: name, state: "skipped", code: "cadence", reason: "Not due." };
    case "deferred":
      return { source: name, state: "deferred", code: "budget", reason: "Waits for budget." };
    case "throttled":
      return {
        source: name,
        state: "throttled",
        code: "throttled",
        reason: "GitHub asked SPI Code to slow down.",
        resumeAt: stamp,
      };
    case "signin":
      return { source: name, state: "failed", code: "signin", reason: "Needs sign-in." };
    case "timeout":
      return { source: name, state: "failed", code: "timeout", reason: "Ran out of time." };
  }
}

let sweeps = 0;
function sweep(
  sources: Record<string, Spec>,
  failed?: { code: string; failure: string; source?: string },
  id = `sweep-${++sweeps}`,
) {
  return event("sweep.progress", {
    sweep: id,
    startedAt: stamp,
    first: false,
    usualMs: null,
    sources: Object.entries(sources).map(([name, spec]) => source(name, spec)),
    ...(failed
      ? { outcome: "failed", nextAttemptAt: null, ...failed }
      : { outcome: "committed", nextAttemptAt: null }),
  });
}

function outage({ focused = false }: { focused?: boolean } = {}) {
  const power = new EventEmitter();
  const open = vi.fn();
  const state = { focused };
  const notifier = createOutageNotifications({ focused: () => state.focused, open, power });
  const shown = () => native.notifications.map(({ options }) => options);
  return { power, open, state, notifier, shown };
}

const healthy = { auth: "read", github: "read", upstream: "read" } as const;

it("notifies once when gh signs out under a source that read, and a committed sweep clears it", () => {
  const { notifier, open, shown } = outage();
  notifier.observe(setup("ready"));
  notifier.observe(snapshot(at(8, 2)));
  notifier.observe(sweep(healthy));
  const lost = sweep({ ...healthy, github: "signin" });
  notifier.observe(lost);
  // auth and github fail for either tool, so the banner waits until setup names the tool.
  expect(shown()).toEqual([]);
  notifier.observe(setup("signed-out"));
  expect(shown()).toEqual([{ title: TITLE, body: "gh is signed out. Today is from 08:02." }]);
  notifier.observe(lost);
  notifier.observe(sweep({ ...healthy, github: "signin", auth: "signin" }));
  notifier.observe(setup("signed-out"));
  vi.advanceTimersByTime(2 * STALL_MS);
  expect(shown()).toHaveLength(1);

  notifier.observe(setup("ready"));
  notifier.observe(sweep(healthy));
  expect(native.notifications[0]?.close).toHaveBeenCalledOnce();
  notifier.observe(sweep({ ...healthy, github: "signin" }));
  expect(shown()).toHaveLength(1);
  notifier.observe(setup("signed-out"));
  expect(shown()).toHaveLength(2);
  native.notifications[1]?.emit("click");
  expect(open).toHaveBeenCalledExactlyOnceWith({ to: "readiness" });
});

it("names glab when upstream or radar lose a sign-in they read with", () => {
  const { notifier, shown } = outage();
  notifier.observe(setup("ready"));
  notifier.observe(snapshot(at(8, 2)));
  notifier.observe(sweep({ ...healthy, radar: "read" }));
  notifier.observe(sweep({ ...healthy, upstream: "skipped", radar: "skipped" }));
  notifier.observe(sweep({ ...healthy, upstream: "signin", radar: "skipped" }));
  expect(shown()).toEqual([{ title: TITLE, body: "glab is signed out. Today is from 08:02." }]);
});

it("treats a sweep that failed for sign-in on a source that read as the same outage", () => {
  const { notifier, shown } = outage();
  notifier.observe(setup("ready"));
  notifier.observe(snapshot(at(8, 2)));
  notifier.observe(sweep(healthy));
  notifier.observe(
    sweep(healthy, { code: "signin", failure: "A tool needs sign-in.", source: "upstream" }),
  );
  expect(shown()).toEqual([{ title: TITLE, body: "glab is signed out. Today is from 08:02." }]);
});

it("stays silent for glab that was never signed in", () => {
  const { notifier, shown } = outage();
  notifier.observe(setup("ready", "signed-out"));
  notifier.observe(snapshot(at(8, 2)));
  for (let minute = 0; minute < 60; minute += 5) {
    notifier.observe(
      sweep({ auth: "signin", github: "read", upstream: "signin", radar: "signin" }),
    );
    notifier.observe(snapshot(at(8, 2) + (minute + 5) * MINUTE));
    vi.advanceTimersByTime(5 * MINUTE);
  }
  expect(shown()).toEqual([]);
});

it("notifies once after 15 awake minutes without a commit, naming the last failure, and opens Evidence", () => {
  const { notifier, open, shown } = outage();
  notifier.observe(status());
  notifier.observe(setup("ready"));
  notifier.observe(snapshot(at(8, 2)));
  vi.advanceTimersByTime(5 * MINUTE);
  notifier.observe(sweep(healthy, { code: "timeout", failure: "The read ran out of time." }));
  vi.advanceTimersByTime(5 * MINUTE);
  notifier.observe(sweep(healthy, { code: "unavailable", failure: "The source is unavailable." }));
  vi.advanceTimersByTime(5 * MINUTE - 1);
  expect(shown()).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(shown()).toEqual([
    { title: TITLE, body: "No sweep has finished since 08:02. Last: The source is unavailable." },
  ]);
  notifier.observe(sweep(healthy, { code: "timeout", failure: "The read ran out of time." }));
  vi.advanceTimersByTime(60 * MINUTE);
  expect(shown()).toHaveLength(1);

  notifier.observe(sweep(healthy));
  notifier.observe(snapshot(at(9, 30)));
  expect(native.notifications[0]?.close).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(STALL_MS);
  expect(shown()).toEqual([
    { title: TITLE, body: "No sweep has finished since 08:02. Last: The source is unavailable." },
    { title: TITLE, body: "No sweep has finished since 09:30." },
  ]);
  native.notifications[1]?.emit("click");
  expect(open).toHaveBeenCalledExactlyOnceWith({ to: "evidence" });
});

it("counts no stall before the first snapshot", () => {
  const { notifier, shown } = outage();
  notifier.observe(sweep(healthy, { code: "timeout", failure: "The read ran out of time." }));
  vi.advanceTimersByTime(60 * MINUTE);
  expect(shown()).toEqual([]);
});

it("redacts and bounds the last failure, never passing command output", () => {
  const { notifier, shown } = outage();
  notifier.observe(snapshot(at(8, 2)));
  notifier.observe(
    sweep(healthy, { code: "other", failure: `token=ghp_${"a".repeat(36)} ${"slow ".repeat(30)}` }),
  );
  vi.advanceTimersByTime(STALL_MS);
  const body = shown()[0]?.body ?? "";
  expect(body).not.toContain("ghp_");
  expect(body).toContain("[redacted]");
  expect(body).toMatch(/^No sweep has finished since 08:02\. Last: \[redacted\] slow .*\.\.\.$/);
  expect(Array.from(body.slice(body.indexOf("Last: ") + 6)).length).toBe(120);
  notifier.observe(sweep(healthy));
  notifier.observe(sweep(healthy, { code: "other", failure: "fatal: could not read /Users/me" }));
  vi.advanceTimersByTime(STALL_MS);
  expect(shown()[1]?.body).toBe("No sweep has finished since 08:02. Last: [redacted].");
});

it("makes no outage of more than 15 minutes asleep, nor at once after resume or unlock", () => {
  const { notifier, power, shown } = outage();
  notifier.observe(snapshot(at(8, 2)));
  vi.advanceTimersByTime(10 * MINUTE);
  power.emit("suspend");
  vi.advanceTimersByTime(90 * MINUTE);
  power.emit("resume");
  expect(shown()).toEqual([]);
  vi.advanceTimersByTime(STALL_MS - 1);
  expect(shown()).toEqual([]);
  notifier.observe(sweep(healthy));
  notifier.observe(snapshot(at(9, 45)));

  vi.advanceTimersByTime(14 * MINUTE);
  power.emit("unlock-screen");
  vi.advanceTimersByTime(STALL_MS - 1);
  expect(shown()).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(shown()).toHaveLength(1);
});

it("drops a stall the focused window held back once the machine wakes", () => {
  const { notifier, power, state, shown } = outage({ focused: true });
  notifier.observe(status());
  notifier.observe(snapshot(at(8, 2)));
  vi.advanceTimersByTime(STALL_MS);
  power.emit("suspend");
  state.focused = false;
  vi.advanceTimersByTime(60 * MINUTE);
  power.emit("resume");
  vi.advanceTimersByTime(STALL_MS - 1);
  expect(shown()).toEqual([]);
});

it("holds an outage while the window is focused and delivers it once the operator looks away", () => {
  const { notifier, state, shown } = outage({ focused: true });
  notifier.observe(status(5 * MINUTE));
  notifier.observe(snapshot(at(8, 2)));
  vi.advanceTimersByTime(STALL_MS + 5 * MINUTE);
  expect(shown()).toEqual([]);
  state.focused = false;
  vi.advanceTimersByTime(5 * MINUTE);
  expect(shown()).toHaveLength(1);
  vi.advanceTimersByTime(60 * MINUTE);
  expect(shown()).toHaveLength(1);

  const signin = outage({ focused: true });
  signin.notifier.observe(setup("signed-out"));
  signin.notifier.observe(snapshot(at(8, 2)));
  signin.notifier.observe(sweep(healthy));
  signin.notifier.observe(sweep({ ...healthy, auth: "signin" }));
  expect(signin.shown()).toHaveLength(1);
  signin.state.focused = false;
  signin.notifier.observe(sweep({ ...healthy, auth: "signin" }));
  expect(signin.shown()).toHaveLength(2);
  expect(signin.shown()[1]).toEqual({
    title: TITLE,
    body: "gh is signed out. Today is from 08:02.",
  });
});

it("never notifies for routine sweeps, a single failed sweep, cut, put-off or throttled sources", () => {
  const { notifier, shown } = outage();
  notifier.observe(status());
  notifier.observe(setup("ready"));
  notifier.observe(snapshot(at(8, 2)));
  notifier.observe(sweep(healthy));
  vi.advanceTimersByTime(5 * MINUTE);
  notifier.observe(
    sweep({ auth: "read", github: "cut", upstream: "deferred", security: "throttled" }),
  );
  notifier.observe(snapshot(at(8, 7)));
  vi.advanceTimersByTime(10 * MINUTE);
  notifier.observe(sweep({ ...healthy, github: "timeout" }, { code: "timeout", failure: "Slow." }));
  vi.advanceTimersByTime(4 * MINUTE);
  notifier.observe(sweep({ ...healthy, upstream: "skipped" }));
  notifier.observe(snapshot(at(8, 21)));
  notifier.observe(sweep(healthy, { code: "budget", failure: "Waits for budget." }));
  vi.advanceTimersByTime(STALL_MS - 1);
  expect(shown()).toEqual([]);
});

it("sends one banner, not two, when a sign-in outage also stops sweeps for 15 minutes", () => {
  const { notifier, shown } = outage();
  notifier.observe(setup("ready"));
  notifier.observe(snapshot(at(8, 2)));
  notifier.observe(sweep(healthy));
  notifier.observe(setup("signed-out"));
  notifier.observe(sweep({ ...healthy, github: "signin" }, { code: "save", failure: "No save." }));
  vi.advanceTimersByTime(60 * MINUTE);
  expect(shown()).toEqual([{ title: TITLE, body: "gh is signed out. Today is from 08:02." }]);
});

it("shows nothing where notifications are unsupported and stops everything on dispose", () => {
  native.supported = false;
  const quiet = outage();
  quiet.notifier.observe(snapshot(at(8, 2)));
  vi.advanceTimersByTime(STALL_MS);
  expect(quiet.shown()).toEqual([]);
  quiet.notifier.dispose();

  native.supported = true;
  const { notifier, power, shown } = outage();
  notifier.observe(snapshot(at(8, 2)));
  vi.advanceTimersByTime(STALL_MS);
  expect(shown()).toHaveLength(1);
  notifier.dispose();
  expect(native.notifications[0]?.close).toHaveBeenCalledOnce();
  expect(power.listenerCount("resume") + power.listenerCount("suspend")).toBe(0);
  notifier.observe(snapshot(at(9, 0)));
  vi.advanceTimersByTime(60 * MINUTE);
  expect(shown()).toHaveLength(1);
});

it("warns without the reason when a banner cannot be shown", () => {
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { notifier } = outage();
  notifier.observe(snapshot(at(8, 2)));
  notifier.observe(sweep(healthy, { code: "other", failure: "Private detail." }));
  vi.advanceTimersByTime(STALL_MS);
  native.notifications[0]?.emit("failed", {}, "Private detail.");
  expect(warned).toHaveBeenCalledExactlyOnceWith(
    "A can't-read notification could not be displayed",
  );
  warned.mockRestore();
});
