// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { AttentionTier as WireTier } from "@spi-code/contracts";
import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type AttentionOptions,
  type AttentionSubject,
  type AttentionTier,
  attentionOf,
  interruptCount,
  LEAD_TIME_MS,
  type PriorAttention,
} from "../src/attention";
import { buildBriefing, type DoctorView } from "../src/brief/index";
import { buildModel, type Model } from "../src/model/index";
import type { QueueItem } from "../src/model/queue";
import { fixtureContext } from "./briefing-setup";
import { FIXTURE_NOW, fixtureFacts, laneFacts } from "./harness";

const CLEAR: DoctorView = { state: "clear", problems: [] };
const NEXT_SYNC = "2026-10-13T00:00:00.000Z";

function fixtureModel(): Model {
  return buildModel(fixtureFacts(), FIXTURE_NOW, {}, fixtureContext);
}

// The fixture with the partition radar predicting a toolchain move at the next sync.
function radarModel(): Model {
  const m = fixtureModel();
  const radar: QueueItem = {
    id: "radar:partition",
    kind: "radar",
    rung: 1,
    scope: "partition",
    cls: "TOOLCHAIN",
    text: "next sync carries Java 25 · 2 commits queued",
    effects: [],
    cause: [{ label: "value", value: "Java 25" }],
    incident: false,
    blocks: 1,
  };
  m.queue.items.push(radar);
  return m;
}

function subject(model: Model, id: string): AttentionSubject {
  const q = model.queue.items.find((i) => i.id === id);
  if (!q) throw new Error(`fixture has ${id}`);
  return { id: q.id, ids: [q.id], rung: q.rung };
}

function opts(over: Partial<AttentionOptions> = {}): AttentionOptions {
  return { now: FIXTURE_NOW, leadTimeMs: LEAD_TIME_MS, ...over };
}

function seen(item: AttentionSubject, over: Partial<PriorAttention> = {}): PriorAttention {
  return { ...item, attention: "ambient", owned: false, ...over };
}

describe("tiers from the fixture state", () => {
  const model = fixtureModel();
  const halt = subject(model, "halt:entitlements");
  const stack = subject(model, "stack:38181620856");
  const due = { at: NEXT_SYNC, before: "next sync" };
  const gate = subject(model, "gate1:legal");
  const approvals = subject(model, "approvals:Azure/osdu-spi-stack");

  test("the lead time defaults to two hours", () => {
    expect(LEAD_TIME_MS).toBe(2 * 60 * 60 * 1000);
  });

  test("a new P0 interrupts, and an unowned P0 keeps interrupting until it resolves", () => {
    expect(attentionOf(halt, model, opts())).toEqual({ attention: "interrupt", owned: false, due });
    const later = opts({ previous: [seen(halt, { attention: "interrupt" })] });
    expect(attentionOf(halt, model, later).attention).toBe("interrupt");
  });

  test("a new P1 surfaces; one already seen is ambient", () => {
    expect(attentionOf(approvals, model, opts()).attention).toBe("surface");
    const later = opts({ previous: [seen(approvals, { attention: "surface" })] });
    expect(attentionOf(approvals, model, later).attention).toBe("ambient");
  });

  test("an owned P0 is quiet until it worsens", () => {
    const owners = new Map([[stack.id, "working" as const]]);
    const before = seen(stack, { rung: 0, attention: "interrupt" });
    expect(attentionOf(stack, model, opts({ owners, previous: [before] }))).toEqual({
      attention: "ambient",
      owned: true,
    });
    const worse = seen(stack, { rung: 1, owned: true });
    expect(attentionOf(stack, model, opts({ owners, previous: [worse] })).attention).toBe(
      "interrupt",
    );
    const after = seen(stack, { owned: true, attention: "interrupt" });
    expect(attentionOf(stack, model, opts({ owners, previous: [after] })).attention).toBe(
      "interrupt",
    );
  });

  test("an owned item interrupts when its owner fails, stalls or loses coverage", () => {
    const previous = [seen(gate)];
    for (const state of ["failed", "stalled", "lost"] as const) {
      const owners = new Map([[gate.id, state]]);
      expect(attentionOf(gate, model, opts({ owners, previous }))).toEqual({
        attention: "interrupt",
        owned: true,
      });
    }
    const working = new Map([[gate.id, "working" as const]]);
    expect(attentionOf(gate, model, opts({ owners: working, previous })).attention).toBe("ambient");
  });

  test("an owned item stays Interrupt when its owner fails, sweep after sweep", () => {
    const owners = new Map([[halt.id, "failed" as const]]);
    let previous: PriorAttention[] = [seen(halt, { attention: "interrupt" })];
    for (let sweep = 0; sweep < 3; sweep++) {
      const now = new Date(FIXTURE_NOW.getTime() + sweep * 5 * 60_000);
      const a = attentionOf(halt, model, opts({ now, owners, previous }));
      expect(a).toEqual({ attention: "interrupt", owned: true, due });
      previous = [{ ...halt, ...a }];
    }
  });

  test("a failed owner that finishes surfaces once and then goes quiet", () => {
    const failed = new Map([[stack.id, "failed" as const]]);
    const done = new Map([[stack.id, "done" as const]]);
    const first = attentionOf(stack, model, opts({ owners: failed, previous: [seen(stack)] }));
    expect(first).toEqual({ attention: "interrupt", owned: true });
    const finished = attentionOf(
      stack,
      model,
      opts({ owners: done, previous: [{ ...stack, ...first }] }),
    );
    expect(finished).toEqual({ attention: "surface", owned: true });
    const working = new Map([[stack.id, "working" as const]]);
    const next = attentionOf(
      stack,
      model,
      opts({ owners: working, previous: [{ ...stack, ...finished }] }),
    );
    expect(next).toEqual({ attention: "ambient", owned: true });
  });

  test("a thread done surfaces", () => {
    const owners = new Map([[gate.id, "done" as const]]);
    expect(attentionOf(gate, model, opts({ owners, previous: [seen(gate)] })).attention).toBe(
      "surface",
    );
  });

  test("a card waiting on a decision interrupts, owned or not", () => {
    const cards = new Set([gate.id]);
    const owners = new Map([[gate.id, "waiting" as const]]);
    expect(attentionOf(gate, model, opts({ cards, previous: [seen(gate)] })).attention).toBe(
      "interrupt",
    );
    expect(attentionOf(gate, model, opts({ cards, owners })).attention).toBe("interrupt");
  });

  test("the carrier of a newly detected theme surfaces", () => {
    const themes = buildBriefing(model, CLEAR, FIXTURE_NOW, fixtureContext).themes;
    const toolchain = themes.find((t) => t.inspect === gate.id);
    expect(toolchain?.id).toBe("toolchain:Java 25");
    const previous = [seen(gate)];
    expect(attentionOf(gate, model, opts({ themes, previous })).attention).toBe("surface");
    const known = themes.map((t) => t.id);
    expect(
      attentionOf(gate, model, opts({ themes, previous, previousThemes: known })).attention,
    ).toBe("ambient");
  });

  test("a failed recovery interrupts", () => {
    const facts = laneFacts();
    for (const d of Object.values(facts.details.data ?? {})) {
      d.environment = d.conclusion === "failure" ? ["environment is not deployable"] : [];
    }
    const once = buildModel(facts, FIXTURE_NOW, {}, fixtureContext);
    const lanes = once.queue.items.find((i) => i.kind === "lanes");
    if (!lanes) throw new Error("fixture has failed lanes");
    const item = { id: lanes.id, ids: [lanes.id], rung: lanes.rung };
    const previous = [seen(item)];
    expect(attentionOf(item, once, opts({ previous })).attention).not.toBe("interrupt");

    for (const d of Object.values(facts.details.data ?? {})) d.attempt = 2;
    const again = buildModel(facts, FIXTURE_NOW, {}, fixtureContext);
    expect(attentionOf(item, again, opts({ previous })).attention).toBe("interrupt");
  });

  test("items that are moving normally are ambient", () => {
    const previous = model.queue.items.map((q) => seen({ id: q.id, ids: [q.id], rung: q.rung }));
    expect(attentionOf(gate, model, opts({ previous })).attention).toBe("ambient");
  });
});

describe("due items", () => {
  const model = radarModel();
  const radar = subject(model, "radar:partition");
  const previous = [seen(radar)];

  test("what the radar predicts and a halt are due before the next sync", () => {
    expect(attentionOf(radar, model, opts({ previous })).due).toEqual({
      at: NEXT_SYNC,
      before: "next sync",
    });
    expect(attentionOf(subject(model, "halt:entitlements"), model, opts()).due).toEqual({
      at: NEXT_SYNC,
      before: "next sync",
    });
    expect(attentionOf(subject(model, "gate1:legal"), model, opts()).due).toBeUndefined();
  });

  test("an unowned due item crosses from Surface to Interrupt at its lead time", () => {
    const boundary = Date.parse(NEXT_SYNC) - LEAD_TIME_MS;
    const at = (ms: number) => attentionOf(radar, model, opts({ now: new Date(ms), previous }));
    expect(at(FIXTURE_NOW.getTime()).attention).toBe("surface");
    expect(at(boundary - 1).attention).toBe("surface");
    expect(at(boundary).attention).toBe("interrupt");
    expect(at(boundary + 60_000).attention).toBe("interrupt");
  });

  test("the lead time is the caller's", () => {
    const now = new Date(Date.parse(NEXT_SYNC) - 3 * 60 * 60 * 1000);
    const short = attentionOf(radar, model, opts({ now, previous }));
    const long = attentionOf(radar, model, opts({ now, previous, leadTimeMs: 4 * 3_600_000 }));
    expect([short.attention, long.attention]).toEqual(["surface", "interrupt"]);
  });

  test("an owned due item surfaces inside its lead time", () => {
    const owners = new Map([[radar.id, "working" as const]]);
    const now = new Date(Date.parse(NEXT_SYNC) - 60_000);
    expect(attentionOf(radar, model, opts({ now, owners, previous }))).toEqual({
      attention: "surface",
      owned: true,
      due: { at: NEXT_SYNC, before: "next sync" },
    });
  });
});

describe("the Today count", () => {
  test("a card, the thread waiting on it and the P0 it owns count once", () => {
    const sources = [
      { id: "halt:entitlements", attention: "interrupt" as const },
      { id: "card:1", ids: ["halt:entitlements"], attention: "interrupt" as const },
      { id: "thread:a", ids: ["card:1", "halt:entitlements"], attention: "interrupt" as const },
    ];
    expect(interruptCount(sources)).toBe(1);
  });

  test("distinct interrupts count apart; surfaced and ambient items do not count", () => {
    expect(
      interruptCount([
        { id: "halt:entitlements", attention: "interrupt" },
        { id: "card:2", ids: ["thread:b"], attention: "interrupt" },
        { id: "thread:b", attention: "interrupt" },
        { id: "gate1:legal", attention: "surface" },
        { id: "rollout", attention: "ambient" },
      ]),
    ).toBe(2);
    expect(interruptCount([])).toBe(0);
  });

  test("a group counts when any member interrupts", () => {
    expect(
      interruptCount([
        { id: "thread:a", ids: ["halt:entitlements"], attention: "ambient" },
        { id: "halt:entitlements", attention: "interrupt" },
      ]),
    ).toBe(1);
  });
});

test("core's tiers are the wire's, Background included", () => {
  expectTypeOf<AttentionTier>().toEqualTypeOf<WireTier>();
});
