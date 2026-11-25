// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AREAS, type Envelope } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { after, midSweep, SWEEP_START } from "../sweep/test-helper.js";
import { sourceState, sweepFill, sweepSegment, sweepTone, sweepWords } from "./sweep.js";

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
    "a settled sweep with every area fresh",
    snapshot(),
    null,
    "fine",
    undefined,
    /^Swept \S+ · all areas read$/,
  ],
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
    "9 of 12",
    /^Swept \S+ · sweeping, 9 of 12 sources done$/,
  ],
  [
    "a first sweep over a snapshot",
    snapshot(),
    midSweep(),
    "run",
    "9 of 12",
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
  ["unread", { source: "runs", state: "unread" } as Envelope, /^not read yet$/, "unread"],
  ["fresh", at("fresh"), /^read \d\d:\d\d$/, "fine"],
  ["stale", at("stale"), /^stale · read \d\d:\d\d$/, "warn"],
  ["incomplete", at("incomplete"), /^incomplete · read \d\d:\d\d$/, "warn"],
  ["cut", at("incomplete", { completeness: cut }), /^read in part · 1 of 3$/, "warn"],
  ["failed with a last read", at("failed"), /^failed · showing \d\d:\d\d$/, "bad"],
  [
    "failed with nothing retained",
    { source: "runs", state: "failed", completeness: { kind: "complete" } } as Envelope,
    /^failed$/,
    "bad",
  ],
  ["failed and cut", at("failed", { completeness: cut }), /^failed · showing/, "bad"],
] as const)("states a %s source from its envelope", (_, envelope, text, tone) => {
  const state = sourceState(envelope, now);
  expect(state.text).toMatch(text);
  expect(state.tone).toBe(tone);
});

it.each([
  ["every area fresh", [], undefined],
  ["an unread area", [{ source: "runs", state: "unread" } as Envelope], undefined],
  ["two stale areas", [at("stale"), at("stale")], "2 stale"],
  [
    "a cut area over a stale one",
    [at("stale"), at("incomplete", { completeness: cut })],
    "1 incomplete",
  ],
  ["a failed area over stale and cut", [at("stale"), at("failed"), at("incomplete")], "1 failed"],
] as const)("words the settled footer by its worst kind: %s", (_, worse, words) => {
  expect(sweepWords([...AREAS.map(fresh), ...worse])).toBe(words);
});
