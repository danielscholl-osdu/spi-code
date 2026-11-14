// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AREAS, type Envelope } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { after, midSweep, SWEEP_START } from "../sweep/test-helper.js";
import { shortWhen, sourceState, sweepFill, sweepSegment, sweepTone } from "./sweep.js";

const sweptAt = after(-60);
const fresh = (source: string): Envelope => ({
  source,
  state: "fresh",
  observedAt: sweptAt,
  completeness: { kind: "complete" },
});
const cut = { kind: "cut", reason: "page_limit", read: 1, total: 3 } as const;
const snapshot = (envelopes: readonly Envelope[] = AREAS.map(fresh)) => ({
  areas: envelopes.map((envelope, i) => ({ area: AREAS[i] ?? "fleet", envelope })),
  provenance: [],
  sweptAt,
  briefing: {},
});
const now = SWEEP_START;
const at = (state: Envelope["state"], extra: Partial<Envelope> = {}) =>
  ({ ...fresh("runs"), state, ...extra }) as Envelope;

it.each([
  ["every area fresh", [], "fine"],
  ["an unread area", [{ source: "runs", state: "unread" } as Envelope], "fine"],
  ["a stale area", [at("stale")], "warn"],
  ["an incomplete area", [at("incomplete")], "warn"],
  ["a cut area", [at("incomplete", { completeness: cut })], "warn"],
  ["a failed area", [at("failed")], "bad"],
  ["a failed area over stale and cut", [at("stale"), at("failed"), at("incomplete")], "bad"],
  ["a stale area over unread", [{ source: "x", state: "unread" } as Envelope, at("stale")], "warn"],
] as const)("tones the sweep by its worst area: %s", (_, worse, tone) => {
  expect(sweepTone([...AREAS.map(fresh), ...worse])).toBe(tone);
});

it.each([
  ["no snapshot, no progress", null, null, "fine", "Not swept", "Waiting for the first sweep"],
  [
    "a first sweep running",
    null,
    midSweep(),
    "run",
    "First sweep",
    "First sweep · 9 of 12 sources done",
  ],
  [
    "a first sweep failed",
    null,
    { ...midSweep(), outcome: "failed", code: "timeout", failure: "x", nextAttemptAt: null },
    "bad",
    "First sweep stopped",
    "First sweep stopped",
  ],
  [
    "a first sweep cancelled",
    null,
    { ...midSweep(), outcome: "cancelled" },
    "bad",
    "First sweep stopped",
    "First sweep stopped",
  ],
  [
    "a later sweep over a snapshot",
    snapshot(),
    midSweep({ first: false }),
    "run",
    "Sweeping",
    /^Swept \S+ · sweeping, 9 of 12 sources done$/,
  ],
  [
    "a first sweep over a snapshot",
    snapshot(),
    midSweep(),
    "run",
    "Sweeping",
    /sweeping, 9 of 12 sources done$/,
  ],
] as const)("reads %s", (_, body, progress, tone, text, sentence) => {
  const view = sweepSegment(body, progress as never, null, now);
  expect(view.tone).toBe(tone);
  expect(view.text).toBe(text);
  expect(view.sentence).toMatch(sentence);
});

it("adds only a future next sweep to the sentence", () => {
  const body = snapshot();
  expect(sweepSegment(body, null, after(300), now).sentence).toMatch(/ · next sweep \S+$/);
  expect(sweepSegment(body, null, after(0), now).sentence).not.toContain("next sweep");
  expect(sweepSegment(body, null, "unknown", now).sentence).not.toContain("next sweep");
  expect(sweepSegment(null, null, after(300), now).sentence).not.toContain("next sweep");
});

it.each([
  ["no progress read", null, null],
  ["a committed sweep", { ...midSweep(), outcome: "committed" }, null],
  ["a running sweep with no sources", midSweep({ sources: [] }), null],
  ["nine of twelve settled", midSweep(), 0.75],
] as const)("fills the progress line for %s", (_, progress, fill) => {
  expect(sweepFill(progress as never)).toBe(fill);
});

it.each([
  ["unread", { source: "runs", state: "unread" } as Envelope, /^not read yet$/, "fine"],
  ["fresh", at("fresh"), /^read \d\d:\d\d$/, "fine"],
  ["stale", at("stale"), /^stale, read \d\d:\d\d$/, "warn"],
  ["incomplete", at("incomplete"), /^incomplete, read \d\d:\d\d$/, "warn"],
  ["cut", at("incomplete", { completeness: cut }), /^cut, read \d\d:\d\d$/, "warn"],
  ["failed with a last read", at("failed"), /^failed, last read \d\d:\d\d$/, "bad"],
  [
    "failed with nothing retained",
    { source: "runs", state: "failed", completeness: { kind: "complete" } } as Envelope,
    /^failed$/,
    "bad",
  ],
  ["failed and cut", at("failed", { completeness: cut }), /^failed, last read/, "bad"],
] as const)("states a %s source from its envelope", (_, envelope, text, tone) => {
  const state = sourceState(envelope, now);
  expect(state.text).toMatch(text);
  expect(state.tone).toBe(tone);
});

const base = new Date(2026, 10, 13, 20, 0).getTime();
const ahead = (ms: number) => new Date(base + ms).toISOString();

it.each([
  ["later today", ahead(3 * 3_600_000 + 59 * 60_000), "23:59 · in 3h"],
  ["within the hour", ahead(40 * 60_000 + 30_000), "20:40 · in 40m"],
  ["under a minute", ahead(10_000), "20:00 · in 1m"],
  ["tomorrow", ahead(22 * 3_600_000 + 10 * 60_000), "Sat 18:10 · in 22h"],
  ["in three days", ahead(3 * 86_400_000), "Mon 20:00 · in 3d"],
  ["over a week out", ahead(8 * 86_400_000), "11-21 20:00 · in 8d"],
  ["past", ahead(-60_000), null],
  ["now", ahead(0), null],
  ["unknown", undefined, null],
  ["empty", "", null],
  ["unparseable", "soon", null],
] as const)("reads the next upstream sync short: %s", (_, at, text) => {
  expect(shortWhen(at, base)).toBe(text);
});
