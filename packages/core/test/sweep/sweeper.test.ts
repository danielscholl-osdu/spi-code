// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createContext } from "../../src/context.js";
import type { Exec } from "../../src/exec/port.js";
import { emptyFacts } from "../../src/facts.js";
import { type SweepArea, Sweeper, type SweepPersist } from "../../src/sweep/sweeper.js";

const measured = z.strictObject({
  at: z.iso.datetime().optional(),
  error: z.string().optional(),
  errorAt: z.iso.datetime().optional(),
});
const factsSchema = z.strictObject({
  fleet: measured,
  github: measured.extend({
    data: z
      .strictObject({
        repos: z.record(z.string(), z.never()),
        planned: z.record(z.string(), z.boolean()),
      })
      .optional(),
  }),
  runs: measured,
  approvals: measured,
  lifecycle: measured,
  details: measured,
  upstream: measured,
  radar: measured,
  template: measured,
  auth: measured.extend({
    data: z
      .strictObject({
        gh: z.strictObject({ ok: z.boolean(), detail: z.string() }),
        glab: z.strictObject({ ok: z.boolean(), detail: z.string() }),
      })
      .optional(),
  }),
  security: measured,
  sweep: z
    .strictObject({
      at: z.iso.datetime(),
      ms: z.number(),
      calls: z.number(),
      errors: z.number(),
    })
    .optional(),
});
const cacheSchema = z.strictObject({ entries: z.array(z.string()) });
type Cache = z.infer<typeof cacheSchema>;
const exec: Exec = {
  runJSON: async () => ({ ok: false, error: "offline", code: null }),
  runText: async () => ({ ok: true, data: "ok" }),
};

function harness(initial?: unknown) {
  let time = Date.parse("2026-11-05T07:00:00Z");
  let stored = initial;
  let loads = 0;
  const clock = { now: () => new Date(time) };
  const persist: SweepPersist<Cache> = {
    load: async () => {
      loads++;
      return structuredClone(stored);
    },
    save: async (state) => {
      stored = structuredClone(state);
    },
  };
  const options = {
    ctx: createContext({ clock }),
    clock,
    exec,
    persist,
    factsSchema,
    cacheSchema,
    emptyCache: () => ({ entries: [] }),
  };
  return {
    options,
    advance: () => {
      time += 60_000;
    },
    stored: () => stored,
    loads: () => loads,
  };
}

function github(): Extract<SweepArea<Cache>, { name: "github" }> {
  return {
    name: "github",
    read: async ({ clock }) => ({
      data: { repos: {}, planned: {} },
      reads: [
        {
          source: "gh",
          object: "repositories",
          observedAt: clock.now().toISOString(),
          completeness: { kind: "cut", reason: "page limit", read: 1, total: 2 },
        },
      ],
    }),
  };
}

describe("Sweeper shell", () => {
  it("awaits areas in order, forwards ports and force, prunes, persists and rebuilds", async () => {
    const h = harness();
    const order: string[] = [];
    const sweeper = new Sweeper({
      ...h.options,
      areas: [
        {
          name: "auth",
          read: async ({ ctx, exec: port, facts, cache, force, clock }) => {
            expect(ctx).toBe(h.options.ctx);
            expect(facts).toEqual(emptyFacts());
            expect(force).toBe(true);
            expect(clock).toBe(h.options.clock);
            expect(await port.runText("gh", ["auth", "status"])).toEqual({ ok: true, data: "ok" });
            order.push("auth");
            cache.entries.push("keep", "drop");
            return {
              data: {
                gh: { ok: true, detail: "signed in" },
                glab: { ok: false, detail: "offline" },
              },
              reads: [],
            };
          },
        },
        {
          ...github(),
          read: async (input) => {
            expect(input.facts.auth.data?.gh.ok).toBe(true);
            order.push("github");
            return github().read(input);
          },
        },
      ],
      prune: (facts, cache, now) => {
        expect(facts.github.data).toBeDefined();
        expect(now).toEqual(h.options.clock.now());
        order.push("prune");
        cache.entries.pop();
      },
    });
    await sweeper.sweep({ force: true });
    expect(order).toEqual(["auth", "github", "prune"]);
    expect(sweeper.cache.entries).toEqual(["keep"]);
    expect(sweeper.model.measured).toBe(true);
    expect(h.stored()).toEqual({
      facts: sweeper.facts,
      cache: sweeper.cache,
      reads: sweeper.reads,
    });
    expect(sweeper.facts.sweep).toMatchObject({ calls: 1, errors: 0 });
    expect(sweeper.reads.github?.[0]?.completeness.kind).toBe("cut");
  });

  it("keeps last-good data and provenance across repeated failures, then clears failure on recovery", async () => {
    const h = harness();
    let fails = false;
    const area = github();
    const sweeper = new Sweeper({
      ...h.options,
      areas: [
        {
          ...area,
          read: async (input) => {
            if (fails) throw new Error("gh unreachable");
            const result = await area.read(input);
            return {
              ...result,
              reads: result.reads.map((record) => ({
                ...record,
                observedAt: new Date(input.clock.now().getTime() - 120_000).toISOString(),
              })),
            };
          },
        },
      ],
    });
    await sweeper.sweep();
    const good = structuredClone(sweeper.facts.github);
    const original = sweeper.reads.github?.[0]?.observedAt;
    expect(original).not.toBe(good.at);
    fails = true;
    for (let i = 0; i < 2; i++) {
      h.advance();
      await sweeper.sweep();
      expect(sweeper.facts.github).toEqual({
        ...good,
        error: "gh unreachable",
        errorAt: h.options.clock.now().toISOString(),
      });
      expect(sweeper.reads.github?.[0]).toMatchObject({
        observedAt: h.options.clock.now().toISOString(),
        retainedFrom: original,
        failure: "gh unreachable",
        completeness: { kind: "cut", read: 1, total: 2 },
      });
      expect(sweeper.model.measured).toBe(true);
      expect(sweeper.facts.sweep?.errors).toBe(1);
    }
    fails = false;
    await sweeper.sweep();
    expect(sweeper.facts.github.error).toBeUndefined();
    expect(sweeper.reads.github?.[0]?.retainedFrom).toBeUndefined();
    expect(sweeper.reads.github?.[0]?.failure).toBeUndefined();
  });

  it("records cold failures without claiming retained data and continues to the next area", async () => {
    const h = harness();
    const sweeper = new Sweeper({
      ...h.options,
      areas: [
        {
          name: "auth",
          read: async () => {
            throw new Error("offline");
          },
        },
        github(),
      ],
    });
    await sweeper.sweep();
    expect(sweeper.facts.auth.data).toBeUndefined();
    expect(sweeper.reads.auth).toEqual([
      {
        source: "auth",
        object: "auth",
        observedAt: h.options.clock.now().toISOString(),
        completeness: { kind: "complete" },
        failure: "offline",
      },
    ]);
    expect(sweeper.model.measured).toBe(true);
  });

  it("round-trips facts, cache and reads through the persist port without sharing references", async () => {
    const h = harness();
    const first = new Sweeper({ ...h.options, areas: [github()] });
    first.cache.entries.push("cached");
    await first.sweep();
    const saved = structuredClone(h.stored());
    const second = new Sweeper({ ...h.options, areas: [] });
    await second.sweep();
    expect({ facts: second.facts, cache: second.cache, reads: second.reads }).toEqual(saved);
    second.cache.entries.push("new");
    expect(first.cache.entries).toEqual(["cached"]);
    expect(second.model.measured).toBe(true);
    expect(h.loads()).toBe(2);
  });

  it("discards an invalid persisted cache but keeps valid facts and records the validation failure", async () => {
    const h = harness();
    const first = new Sweeper({ ...h.options, areas: [github()] });
    await first.sweep();
    const bad = harness({ facts: first.facts, cache: { entries: [42] }, reads: first.reads });
    const restored = new Sweeper({ ...bad.options, areas: [] });
    await restored.sweep();
    expect(restored.cache).toEqual({ entries: [] });
    expect(restored.facts.github).toEqual(first.facts.github);
    expect(restored.reads.persist?.[0]).toMatchObject({
      source: "persist",
      object: "cache",
      failure: expect.stringContaining("Invalid persisted state"),
    });
    expect(restored.model.measured).toBe(true);
  });

  it("discards invalid facts or read provenance before rebuilding", async () => {
    for (const initial of [
      { facts: { github: { data: "bad" } }, cache: { entries: [] }, reads: {} },
      {
        facts: emptyFacts(),
        cache: { entries: [] },
        reads: {
          github: [
            {
              source: "gh",
              object: "repos",
              observedAt: "yesterday",
              completeness: { kind: "complete" },
            },
          ],
        },
      },
    ]) {
      const h = harness(initial);
      const sweeper = new Sweeper({ ...h.options, areas: [] });
      await expect(sweeper.sweep()).resolves.toBeUndefined();
      expect(sweeper.model.measured).toBe(false);
      expect(sweeper.reads.persist?.[0]?.failure).toContain("Invalid persisted state");
    }
  });

  it("coalesces overlapping sweeps including initialization and can sweep again", async () => {
    const h = harness();
    let calls = 0;
    const sweeper = new Sweeper({
      ...h.options,
      areas: [
        {
          ...github(),
          read: async (input) => {
            calls++;
            return github().read(input);
          },
        },
      ],
    });
    const pending = sweeper.sweep();
    expect(sweeper.sweeping).toBe(true);
    expect(sweeper.sweep()).toBe(pending);
    await pending;
    expect(sweeper.sweeping).toBe(false);
    await sweeper.sweep();
    expect(calls).toBe(2);
    expect(h.loads()).toBe(1);
  });

  it("records load failures and continues collecting from an empty state", async () => {
    const h = harness();
    const sweeper = new Sweeper({
      ...h.options,
      areas: [github()],
      persist: {
        ...h.options.persist,
        load: async () => {
          throw new Error("load unavailable");
        },
      },
    });
    await sweeper.sweep();
    expect(sweeper.reads.persist?.[0]).toMatchObject({
      object: "load",
      failure: "load unavailable",
    });
    expect(sweeper.model.measured).toBe(true);
    expect(h.stored()).toMatchObject({ reads: sweeper.reads });
  });

  it("exposes save failures instead of reporting durable success", async () => {
    const h = harness();
    const sweeper = new Sweeper({
      ...h.options,
      areas: [github()],
      persist: {
        load: h.options.persist.load,
        save: async () => {
          throw new Error("disk full");
        },
      },
    });
    await expect(sweeper.sweep()).rejects.toThrow("disk full");
    expect(sweeper.reads.persist?.[0]?.failure).toBe("disk full");
    expect(sweeper.model.measured).toBe(true);
    expect(sweeper.sweeping).toBe(false);
  });
});
