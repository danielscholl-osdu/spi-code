// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createContext } from "../src/context.js";
import type { Exec } from "../src/exec/port.js";
import { type AuthFacts, emptyFacts, type Facts } from "../src/facts.js";
import { factsSchema } from "../src/facts-schema.js";
import { type SweepArea, Sweeper, type SweepState } from "../src/sweep/sweeper.js";
import { fixtureFacts } from "./harness";

const cacheSchema = z.strictObject({});
type Cache = z.infer<typeof cacheSchema>;
const exec: Exec = {
  runJSON: async () => ({ ok: false, error: "offline", code: null }),
  runText: async () => ({ ok: false, error: "offline", code: null }),
};
const auth = { gh: { ok: true, detail: "signed in" }, glab: { ok: true, detail: "signed in" } };

function malformed(): Record<string, [string, unknown, (string | number)[]]> {
  const missing = fixtureFacts();
  const repo = Object.values(missing.github.data?.repos ?? {})[0];
  if (!repo) throw new Error("fixture has repos");
  Reflect.deleteProperty(repo, "prs");
  return {
    "a missing required field": ["prs", missing, ["github", "data", "repos", repo.repo, "prs"]],
    "a wrong type": [
      "ok",
      { ...emptyFacts(), auth: { data: { ...auth, gh: { ok: "yes", detail: "x" } } } },
      ["auth", "data", "gh", "ok"],
    ],
    "an unknown top-level key": ["stray", { ...emptyFacts(), stray: {} }, []],
    "a missing area": ["security", { ...emptyFacts(), security: undefined }, ["security"]],
  };
}

function sweeper(
  options: { areas?: SweepArea<Cache>[]; replay?: () => Promise<unknown>; stored?: unknown } = {},
) {
  const saved: SweepState<Cache>[] = [];
  const instance = new Sweeper<Cache>({
    ctx: createContext({ clock: { now: () => new Date("2026-11-05T07:00:00Z") } }),
    exec,
    persist: {
      load: async () => structuredClone(options.stored),
      save: async (state) => {
        saved.push(structuredClone(state));
      },
    },
    areas: options.areas ?? [],
    factsSchema,
    cacheSchema,
    emptyCache: () => ({}),
    ...(options.replay ? { replay: options.replay } : {}),
  });
  return { instance, saved };
}

describe("factsSchema", () => {
  it("parses the recorded rib fixture and empty facts without dropping a key", () => {
    const facts = fixtureFacts();
    expect(factsSchema.parse(structuredClone(facts))).toEqual(facts);
    expect(factsSchema.parse(emptyFacts())).toEqual(emptyFacts());
  });

  it.each(Object.entries(malformed()))(
    "rejects %s, naming the path",
    (_name, [key, value, path]) => {
      const result = factsSchema.safeParse(value);
      expect(result.success).toBe(false);
      const issue = result.error?.issues[0];
      expect(issue?.path).toEqual(path);
      if (path.length === 0)
        expect(issue).toMatchObject({ code: "unrecognized_keys", keys: [key] });
    },
  );

  it("rejects a malformed replay and keeps the facts it had", async () => {
    const good: SweepState<Cache> = { facts: fixtureFacts(), cache: {}, reads: {} };
    let next: unknown = good;
    const { instance, saved } = sweeper({ replay: async () => structuredClone(next) });
    await instance.sweep();
    expect(instance.facts).toEqual(good.facts);
    for (const [, [, facts, path]] of Object.entries(malformed())) {
      next = { ...good, facts };
      const error = await instance.sweep().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues[0]?.path).toEqual(["facts", ...path]);
      expect(instance.facts).toEqual(good.facts);
    }
    expect(saved).toEqual([]);
  });

  it("refuses a malformed commit, keeps the last good area data and saves only valid state", async () => {
    let data: unknown = auth;
    const { instance, saved } = sweeper({
      areas: [{ name: "auth", read: async () => ({ data: data as AuthFacts, reads: [] }) }],
    });
    await instance.sweep();
    expect(saved.at(-1)?.facts.auth.data).toEqual(auth);
    data = { ...auth, gh: { ok: "yes", detail: "x" } };
    await instance.sweep();
    expect(instance.facts.auth.data).toEqual(auth);
    expect(instance.facts.auth.error).toContain('"gh"');
    expect(saved).toHaveLength(2);
    expect(saved.at(-1)?.facts.auth.data).toEqual(auth);
    expect(factsSchema.safeParse(saved.at(-1)?.facts).success).toBe(true);
  });

  it("loads a snapshot the previous unchecked wiring saved, and refuses a malformed one", async () => {
    const legacy: SweepState<Cache>[] = [];
    const previous = new Sweeper<Cache>({
      ctx: createContext(),
      exec,
      persist: { load: async () => undefined, save: async (state) => void legacy.push(state) },
      areas: [{ name: "auth", read: async () => ({ data: auth, reads: [] }) }],
      factsSchema: z.custom<Facts>((value) => typeof value === "object" && value !== null),
      cacheSchema,
      emptyCache: () => ({}),
      prune: (facts) => Object.assign(facts, { ...fixtureFacts(), auth: facts.auth }),
    });
    await previous.sweep();
    const stored = JSON.parse(JSON.stringify(legacy.at(-1)));
    const current = sweeper({ stored });
    await current.instance.sweep();
    expect(current.instance.reads.persist).toBeUndefined();
    expect(current.instance.facts.github).toEqual(fixtureFacts().github);
    expect(current.instance.facts.auth.data).toEqual(auth);

    const bad = sweeper({ stored: { ...stored, facts: { ...stored.facts, stray: 1 } } });
    await bad.instance.sweep();
    expect(bad.instance.facts.github).toEqual({});
    expect(bad.saved.at(-1)?.reads.persist).toBeUndefined();
    expect(bad.instance.reads.persist?.[0]?.failure).toContain("Invalid persisted state");
  });
});
