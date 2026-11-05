// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { BudgetPacer, type ReadRecord, envelopeOf } from "./index.js";

const start = "2026-11-05T00:00:00.000Z";
const now = Date.parse(start);
const record: ReadRecord = Object.freeze({
  source: "github",
  object: "repo",
  observedAt: start,
  completeness: { kind: "complete" as const },
});
const envelope = (records: readonly ReadRecord[], elapsed = 0) =>
  envelopeOf(records, { intervalMs: 1_000, now: now + elapsed });

describe("read evidence", () => {
  it.each([
    [0, "fresh"],
    [1_999, "fresh"],
    [2_000, "fresh"],
    [2_001, "stale"],
  ] as const)("at age %d reports %s", (elapsed, state) => {
    expect(envelope([record], elapsed)).toMatchObject({
      state,
      observedAt: start,
      completeness: { kind: "complete" },
    });
  });

  it("distinguishes unread from a failed first read and a failed retained read", () => {
    expect(envelope([])).toMatchObject({ state: "unread", inferred: false });
    expect(envelope([{ ...record, failure: "denied" }])).toMatchObject({ state: "failed" });
    expect(envelope([{ ...record, failure: "denied" }]).observedAt).toBeUndefined();
    expect(
      envelope([{ ...record, failure: "denied", retainedFrom: start }], 2_001),
    ).toMatchObject({ state: "failed", observedAt: start });
  });

  it("keeps cuts independent of age and uses the oldest retained time across the area", () => {
    const completeness = { kind: "cut", reason: "page limit", read: 10, total: 20 } as const;
    const cut = { ...record, object: "pulls", completeness };
    const retained = {
      ...record,
      observedAt: "2026-11-05T00:00:01.000Z",
      retainedFrom: "2026-11-04T23:59:00.000Z",
    };
    for (const records of [[cut, retained], [retained, cut]]) {
      expect(envelope(records, 3_000)).toMatchObject({
        state: "incomplete",
        observedAt: retained.retainedFrom,
        completeness,
        records,
      });
    }
    expect(envelope([{ ...cut, failure: "timeout" }, retained])).toMatchObject({
      state: "failed",
      completeness,
    });
  });

  it("uses the oldest successful read and marks only wholly inferred evidence inferred", () => {
    const recent = { ...record, observedAt: "2026-11-05T00:00:01.000Z", inferred: true };
    expect(envelope([recent, record], 2_001).state).toBe("stale");
    expect(envelope([recent, record]).inferred).toBe(false);
    expect(envelope([recent]).inferred).toBe(true);
  });

  it("rejects malformed clocks rather than reporting fresh evidence", () => {
    expect(() => envelope([{ ...record, observedAt: "invalid" }])).toThrow("timestamp");
    expect(() => envelope([{ ...record, retainedFrom: "invalid" }])).toThrow("timestamp");
    expect(() => envelopeOf([record], { intervalMs: -1, now })).toThrow("intervalMs");
    expect(() => envelopeOf([record], { intervalMs: 1, now: Number.NaN })).toThrow("now");
  });
});

describe("budget pacing", () => {
  const areas = [
    { area: "github", core: true, estimate: 10 },
    { area: "security", core: false, estimate: 20 },
    { area: "details", core: false, estimate: 5 },
  ] as const;
  const pacer = new BudgetPacer({ floor: 10, resetBudget: 100 });
  const input = { areas, history: [], now };

  it("runs core reads and defers security and details when budget is unknown", () => {
    expect(pacer.plan(input)).toEqual([
      { area: "github", kind: "run", estimate: 10 },
      { area: "security", kind: "defer", estimate: 20, reason: "budget unknown" },
      { area: "details", kind: "defer", estimate: 5, reason: "budget unknown" },
    ]);
  });

  it("uses configured cold-start estimates and reserves cumulative costs plus the floor", () => {
    expect(pacer.plan({ ...input, remaining: 40 }).map((decision) => decision.kind)).toEqual([
      "run", "run", "defer",
    ]);
    expect(pacer.plan({ ...input, remaining: 39 }).map((decision) => decision.kind)).toEqual([
      "run", "defer", "run",
    ]);
    for (const remaining of [0, 9, 10, 19, 20, 39, 40, 45, 100]) {
      const decisions = pacer.plan({ ...input, remaining });
      const spent = decisions.reduce(
        (sum, decision) => sum + (decision.kind === "run" ? decision.estimate : 0), 0,
      );
      expect(spent).toBeLessThanOrEqual(Math.max(0, remaining - pacer.floor));
    }
  });

  it("uses the maximum measured area cost without sharing history across plans", () => {
    const history = [{ area: "github", cost: 50 }, { area: "github", cost: 5 }];
    expect(pacer.plan({ ...input, history, remaining: 40 })[0]).toMatchObject({
      kind: "defer", estimate: 50,
    });
    expect(pacer.plan({ ...input, remaining: 40 })[0]).toMatchObject({
      kind: "run", estimate: 10,
    });
    expect(new BudgetPacer({ floor: 40, resetBudget: 100 }).plan({
      ...input, remaining: 40,
    }).every((decision) => decision.kind === "defer")).toBe(true);
  });

  it.each([-1, 0, 1])("re-enables areas at reset boundary %dms", (offset) => {
    const resetAt = "2026-11-05T00:00:01.000Z";
    const decisions = pacer.plan({
      ...input, remaining: 0, resetAt, now: now + 1_000 + offset,
    });
    if (offset < 0) {
      expect(decisions.every((decision) =>
        decision.kind === "wait-until-reset" && decision.until === resetAt)).toBe(true);
    } else {
      expect(decisions.every((decision) => decision.kind === "run")).toBe(true);
    }
  });

  it("does not bypass the floor after reset or leak reservations between plans", () => {
    const constrained = new BudgetPacer({ floor: 90, resetBudget: 100 });
    const request = { ...input, remaining: 0, resetAt: start };
    expect(constrained.plan(request).map((decision) => decision.kind)).toEqual([
      "run", "defer", "defer",
    ]);
    expect(constrained.plan(request)).toEqual(constrained.plan(request));
  });

  it("rejects invalid budgets, costs, timestamps and duplicate areas", () => {
    expect(() => new BudgetPacer({ floor: 11, resetBudget: 10 })).toThrow("floor");
    expect(() => pacer.plan({ ...input, remaining: -1 })).toThrow("remaining");
    expect(() => pacer.plan({ ...input, resetAt: "bad" })).toThrow("timestamp");
    expect(() => pacer.plan({ ...input, history: [{ area: "github", cost: -1 }] })).toThrow("cost");
    expect(() => pacer.plan({ ...input, areas: [areas[0], areas[0]] })).toThrow("Duplicate");
  });
});
