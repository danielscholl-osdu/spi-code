// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createContext } from "../../src/context.js";
import { type Exec, execOutputDelivery } from "../../src/exec/port.js";
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
  runJSON: async (_cmd, _args, opts) => ({
    ok: false,
    error: opts?.signal?.aborted ? "Command aborted." : "offline",
    code: null,
  }),
  runText: async (_cmd, _args, opts = {}) => {
    const delivery = execOutputDelivery(opts);
    delivery.push("stdout", "ok");
    delivery.finish();
    return opts.signal?.aborted
      ? { ok: false, error: "Command aborted.", code: null }
      : { ok: true, data: "ok" };
  },
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

  it("does not invent retained provenance when persisted area reads are empty", async () => {
    const h = harness();
    const first = new Sweeper({ ...h.options, areas: [github()] });
    await first.sweep();
    const restored = new Sweeper({
      ...harness({ facts: first.facts, cache: first.cache, reads: { github: [] } }).options,
      areas: [
        {
          name: "github",
          read: async () => {
            throw new Error("offline");
          },
        },
      ],
    });
    await restored.sweep();
    expect(restored.facts.github.data).toEqual(first.facts.github.data);
    expect(restored.reads.github).toEqual([
      {
        source: "github",
        object: "github",
        observedAt: h.options.clock.now().toISOString(),
        completeness: { kind: "complete" },
        failure: "offline",
      },
    ]);
  });

  it.each(["facts", "cache"])(
    "rejects invalid area %s and rolls back its writes",
    async (invalid) => {
      const h = harness();
      let fails = false;
      const sweeper = new Sweeper({
        ...h.options,
        areas: [
          {
            ...github(),
            read: async (input) => {
              const result = await github().read(input);
              if (fails) {
                input.cache.entries.push("discard");
                if (input.facts.github.data) input.facts.github.data.planned.changed = true;
                if (invalid === "facts") Reflect.set(result.data, "planned", 42);
                else Reflect.set(input.cache, "entries", [42]);
              }
              return result;
            },
          },
        ],
      });
      await sweeper.sweep();
      const good = structuredClone(sweeper.facts.github);
      const reads = structuredClone(sweeper.reads.github);
      fails = true;
      h.advance();
      await expect(sweeper.sweep()).resolves.toBeUndefined();
      expect(sweeper.facts.github.data).toEqual(good.data);
      expect(sweeper.facts.github.at).toBe(good.at);
      expect(sweeper.cache).toEqual({ entries: [] });
      expect(sweeper.reads.github?.[0]).toMatchObject({
        failure: expect.stringContaining("Invalid"),
        retainedFrom: reads?.[0]?.observedAt,
      });
      expect(sweeper.facts.sweep?.errors).toBe(1);
      expect(sweeper.model.measured).toBe(true);
    },
  );

  it("retains provenance when the last-good data already carried a partial failure", async () => {
    const h = harness();
    let fails = false;
    const sweeper = new Sweeper({
      ...h.options,
      areas: [
        {
          ...github(),
          read: async (input) => {
            if (fails) throw new Error("offline");
            const result = await github().read(input);
            return {
              ...result,
              reads: result.reads.map((record) => ({ ...record, failure: "one repo failed" })),
            };
          },
        },
      ],
    });
    await sweeper.sweep();
    const original = sweeper.reads.github?.[0]?.observedAt;
    fails = true;
    h.advance();
    await sweeper.sweep();
    expect(sweeper.reads.github?.[0]).toMatchObject({
      failure: "offline",
      retainedFrom: original,
    });
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

  it("rebuilds the persisted model before a slow area completes", async () => {
    const h = harness();
    const first = new Sweeper({ ...h.options, areas: [github()] });
    await first.sweep();
    const gate: { release?: () => void; entered?: () => void } = {};
    const waiting = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      gate.entered = resolve;
    });
    const restored = new Sweeper({
      ...h.options,
      areas: [
        {
          ...github(),
          read: async (input) => {
            gate.entered?.();
            await waiting;
            return github().read(input);
          },
        },
      ],
    });
    const pending = restored.sweep();
    await entered;
    try {
      expect(restored.sweeping).toBe(true);
      expect(restored.model.measured).toBe(true);
      expect(restored.model.sweptAt).toBe(first.model.sweptAt);
    } finally {
      gate.release?.();
      await pending;
    }
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
    expect(h.stored()).toMatchObject({ reads: { github: sweeper.reads.github } });
    expect(h.stored()).not.toHaveProperty("reads.persist");
  });

  it.each(["load", "save"])(
    "clears a recovered %s failure in memory and after restart",
    async (kind) => {
      const h = harness();
      let fail = true;
      const sweeper = new Sweeper({
        ...h.options,
        areas: [github()],
        persist: {
          load: async () => {
            if (fail && kind === "load") throw new Error("cannot load");
            return h.options.persist.load();
          },
          save: async (state) => {
            if (fail && kind === "save") throw new Error("cannot save");
            await h.options.persist.save(state);
          },
        },
      });
      if (kind === "save") await expect(sweeper.sweep()).rejects.toThrow("cannot save");
      else await sweeper.sweep();
      expect(sweeper.reads.persist?.[0]?.object).toBe(kind);
      fail = false;
      await sweeper.sweep();
      expect(sweeper.reads.persist).toBeUndefined();
      expect(h.stored()).not.toHaveProperty("reads.persist");
      const restarted = new Sweeper({ ...h.options, areas: [] });
      await restarted.sweep();
      expect(restarted.reads.persist).toBeUndefined();
    },
  );

  it("does not restore legacy persisted diagnostics", async () => {
    const h = harness({
      facts: emptyFacts(),
      cache: { entries: [] },
      reads: {
        persist: [
          {
            source: "persist",
            object: "save",
            observedAt: "2026-11-05T07:00:00Z",
            completeness: { kind: "complete" },
            failure: "old failure",
          },
        ],
      },
    });
    const sweeper = new Sweeper({ ...h.options, areas: [] });
    await sweeper.sweep();
    expect(sweeper.reads.persist).toBeUndefined();
    expect(h.stored()).not.toHaveProperty("reads.persist");
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
