// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { javaOf, pinPoms, type ReleasePersist, ReleaseReader } from "../../src/collect/releases.js";
import { fleetOf, RELEASES_EVERY_MS } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { envelopeOf } from "../../src/evidence/index.js";
import { RecordingExec, ReplayExec } from "../../src/exec/index.js";
import { Gh, GraphqlBudget } from "../../src/forge.js";
import { pinKey } from "../../src/releases.js";

const START = "2026-10-21T15:00:00.000Z";
const RELEASE = { tag: "v1.0.0", at: "2026-10-01T00:00:00Z", body: "" };

function harness(repo = "test/service") {
  let time = Date.parse(START);
  const ctx = createContext({
    fleet: fleetOf([{ id: "service", repo, upstream: "upstream/service" }]),
    clock: { now: () => new Date(time) },
  });
  let stored: unknown;
  const persist: ReleasePersist = {
    load: async () => stored,
    save: async (state) => {
      stored = structuredClone(state);
    },
  };
  const log: string[] = [];
  const calls: string[] = [];
  const faults = { pins: false, releases: false, created: false, truncated: false };
  const exec = new RecordingExec(
    async (_cmd, args) => {
      calls.push(args.join(" "));
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query) {
        const rate = { cost: 3, remaining: 1000, resetAt: "2026-10-22T00:00:00Z" };
        const creation = query.includes("createdAt");
        const values = creation
          ? Object.fromEntries(
              ctx.fleet.releaseRepos.map((_, i) => [
                `r${i}`,
                faults.created ? null : { createdAt: START },
              ]),
            )
          : {
              repository: {
                p0: { text: "<java.version>25</java.version>" },
                p1: { text: "<core-lib-azure.version>3.0.1</core-lib-azure.version>" },
              },
            };
        return {
          stdout: JSON.stringify({
            data: { ...values, spicodeBudget: rate },
            errors:
              (!creation && faults.pins) || (creation && faults.created)
                ? [{ message: "Something went wrong" }]
                : [],
          }),
          stderr: "",
          exit: 0,
        };
      }
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path.includes("/releases")) {
        return {
          stdout: path.startsWith(`repos/${repo}/`) ? JSON.stringify(RELEASE) : "",
          stderr: "release read failed",
          exit: faults.releases && path.startsWith(`repos/${repo}/`) ? 1 : 0,
        };
      }
      return {
        stdout: JSON.stringify({
          paths: ["pom.xml", "provider/azure/pom.xml"],
          truncated: faults.truncated,
        }),
        stderr: "",
        exit: 0,
      };
    },
    (line) => {
      log.push(line);
    },
  );
  const budget = new GraphqlBudget(ctx.clock);
  const reader = new ReleaseReader(new Gh(exec, undefined, budget), persist, ctx);
  return {
    ctx,
    persist,
    log,
    calls,
    faults,
    budget,
    reader,
    key: pinKey(repo, RELEASE.tag),
    repo,
    advance: (ms: number) => {
      time += ms;
    },
    store: (value: unknown) => {
      stored = value;
    },
  };
}

test("a pin read with GraphQL errors is recorded and retried, never cached (replay)", async () => {
  const h = harness();
  h.faults.pins = true;
  await h.reader.read({ force: true });
  expect(h.reader.data.pins[h.key]).toBeUndefined();
  expect(h.reader.data.errors[h.key]).toContain("Something went wrong");
  const replay = new ReplayExec(h.log.join(""));
  const reader = new ReleaseReader(
    new Gh(replay),
    { load: async () => undefined, save: async () => {} },
    h.ctx,
  );
  await reader.read({ force: true });
  expect(reader.data).toEqual(h.reader.data);
  replay.assertExhausted();
  h.faults.pins = false;
  await h.reader.read({ force: true });
  expect(h.reader.data.pins[h.key]).toEqual({ java: "25", lib: "3.0.1" });
});

test("poms: Java from the first property set, test modules never pin the library", () => {
  expect(javaOf("<java.version>25</java.version>")).toBe("25");
  expect(javaOf("<maven.compiler.target>1.8</maven.compiler.target>")).toBe("8");
  expect(javaOf("<project/>")).toBeNull();
  expect(
    javaOf("<maven.compiler.release>21</maven.compiler.release><java.version>25</java.version>"),
  ).toBe("25");
  expect(
    pinPoms([
      "pom.xml",
      "provider/unit-azure/unit-aks/pom.xml",
      "indexer-queue-azure-enqueue/pom.xml",
      "testing/indexer-queue-azure-enqueue/pom.xml",
      "unit-core/pom.xml",
    ]),
  ).toEqual(["provider/unit-azure/unit-aks/pom.xml", "indexer-queue-azure-enqueue/pom.xml"]);
});

test("cadence includes the exact boundary, coalesces in-flight reads and caches pins", async () => {
  const h = harness();
  const first = h.reader.read();
  expect(h.reader.busy).toBe(true);
  expect(h.reader.read()).toBe(first);
  await first;
  const count = h.calls.length;
  h.advance(RELEASES_EVERY_MS - 1);
  await h.reader.read();
  expect(h.calls).toHaveLength(count);
  h.advance(1);
  await h.reader.read();
  expect(h.calls.length).toBeGreaterThan(count);
  expect(h.calls.filter((call) => call.includes("git/trees"))).toHaveLength(1);
  expect(h.reader.data.at).toBe(h.ctx.clock.now().toISOString());
  expect(h.reader.busy).toBe(false);
});

test("a due re-read stamps cached pins with its own time, so Release lines read fresh", async () => {
  const h = harness();
  await h.reader.read();
  h.advance(14 * RELEASES_EVERY_MS);
  await h.reader.read();
  const now = h.ctx.clock.now();
  expect(h.calls.filter((call) => call.includes("git/trees"))).toHaveLength(1);
  expect(h.reader.records.find((r) => r.object === h.key)).toMatchObject({
    source: "github-pins",
    observedAt: now.toISOString(),
  });
  expect(
    envelopeOf(h.reader.records, { intervalMs: RELEASES_EVERY_MS, now: now.getTime() }),
  ).toMatchObject({ state: "fresh", observedAt: now.toISOString() });
});

test("Release lines not read for over twice their interval stay stale at their last read", async () => {
  const h = harness();
  await h.reader.read();
  h.advance(RELEASES_EVERY_MS - 1);
  await h.reader.read();
  expect(h.reader.records.every((r) => r.observedAt === START)).toBe(true);
  h.advance(RELEASES_EVERY_MS + 2);
  expect(
    envelopeOf(h.reader.records, {
      intervalMs: RELEASES_EVERY_MS,
      now: h.ctx.clock.now().getTime(),
    }),
  ).toMatchObject({ state: "stale", observedAt: START });
});

test("a re-read drops records for repos and tags it no longer reads", async () => {
  const before = harness();
  await before.reader.read();
  const after = harness("test/other");
  after.store(await before.persist.load());
  after.advance(14 * RELEASES_EVERY_MS);
  await after.reader.read();
  const objects = after.reader.records.map((r) => r.object);
  expect(objects).not.toContain(before.key);
  expect(objects).not.toContain(before.repo);
  expect(objects).toContain(after.key);
  expect(
    after.reader.records.every((r) => r.observedAt === after.ctx.clock.now().toISOString()),
  ).toBe(true);
});

test("state and each source timestamp round-trip without freshening cached data", async () => {
  const h = harness();
  await h.reader.read();
  const recorded = new ReplayExec(h.log.join(""));
  const replayed = new ReleaseReader(
    new Gh(recorded),
    { load: async () => undefined, save: async () => {} },
    h.ctx,
  );
  await replayed.read();
  expect(replayed.data).toEqual(h.reader.data);
  recorded.assertExhausted();
  const replay = new ReplayExec("");
  const restored = new ReleaseReader(new Gh(replay), h.persist, h.ctx);
  await restored.read();
  expect(restored.data).toEqual(h.reader.data);
  expect(restored.data.created[h.repo]).toBe(START);
  expect(restored.records.find((r) => r.object === h.key)?.observedAt).toBe(START);
  replay.assertExhausted();
});

test.each([{ pins: {} }, { ...emptyState(), pins: { bad: { lib: 42, java: null } } }])(
  "invalid persisted state is discarded with a failure record",
  async (invalid) => {
    const h = harness();
    h.store(invalid);
    await h.reader.read();
    expect(h.reader.data.pins.bad).toBeUndefined();
    expect(h.reader.records).toContainEqual(
      expect.objectContaining({
        source: "release-state",
        object: "load",
        failure: expect.stringContaining("Invalid persisted"),
      }),
    );
  },
);

function emptyState() {
  return { releases: {}, pins: {}, created: {}, errors: {} };
}

test("failed refresh retains pins and releases at their own last good time, including after restart", async () => {
  const h = harness();
  await h.reader.read();
  h.advance(RELEASES_EVERY_MS);
  h.faults.pins = true;
  h.faults.releases = true;
  h.faults.created = true;
  const start = h.log.length;
  await h.reader.read({ force: true, refreshPins: true });
  expect(h.reader.data.pins[h.key]).toEqual({ java: "25", lib: "3.0.1" });
  expect(h.reader.data.releases[h.repo]).toEqual([RELEASE]);
  for (const object of [h.key, h.repo]) {
    expect(
      h.reader.records
        .filter((r) => r.object === object)
        .every((r) => r.retainedFrom === START && r.failure !== undefined),
    ).toBe(true);
  }
  h.advance(RELEASES_EVERY_MS);
  const log = new ReplayExec(h.log.slice(start).join(""));
  const restored = new ReleaseReader(new Gh(log), h.persist, h.ctx);
  await restored.read({ force: true, refreshPins: true });
  expect(restored.records.find((r) => r.object === h.key)?.retainedFrom).toBe(START);
  log.assertExhausted();
  h.faults.pins = false;
  await h.reader.read();
  expect(h.reader.records.find((r) => r.object === h.key)).toMatchObject({
    observedAt: h.ctx.clock.now().toISOString(),
  });
  expect(h.reader.records.find((r) => r.object === h.key)?.retainedFrom).toBeUndefined();
  expect(h.reader.data.errors[h.key]).toBeUndefined();
});

test("truncated trees do not replace cached pins with a partial read", async () => {
  const h = harness();
  await h.reader.read();
  h.advance(RELEASES_EVERY_MS);
  h.faults.truncated = true;
  await h.reader.read({ force: true, refreshPins: true });
  expect(h.reader.data.pins[h.key]).toEqual({ java: "25", lib: "3.0.1" });
  expect(h.reader.records.find((r) => r.object === h.key)).toMatchObject({
    retainedFrom: START,
    failure: expect.stringContaining("tree truncated"),
  });
});

test("release GraphQL cost is charged through Gh and interleaved fleets remain isolated", async () => {
  const a = harness("one/service");
  const b = harness("two/service");
  await Promise.all([a.reader.read(), b.reader.read()]);
  expect(a.budget.snapshot()).toMatchObject({ calls: 2, spent: 6, remaining: 999 });
  expect(a.reader.data.pins[b.key]).toBeUndefined();
  expect(b.reader.data.pins[a.key]).toBeUndefined();
  expect(a.calls.some((call) => call.includes("two/service"))).toBe(false);
  expect(b.calls.some((call) => call.includes("one/service"))).toBe(false);
});

test("persistence failures produce failure records and save failures reject", async () => {
  const h = harness();
  await h.reader.read();
  const replay = new ReplayExec(h.log.join(""));
  let fail = true;
  let saved: unknown;
  const reader = new ReleaseReader(
    new Gh(replay),
    {
      load: async () => {
        throw new Error("load unavailable");
      },
      save: async (state) => {
        if (fail) throw new Error("save unavailable");
        saved = structuredClone(state);
      },
    },
    h.ctx,
  );
  await expect(reader.read()).rejects.toThrow("save unavailable");
  expect(reader.records.filter((r) => r.source === "release-state").map((r) => r.failure)).toEqual([
    "load unavailable",
    "save unavailable",
  ]);
  expect(reader.busy).toBe(false);
  fail = false;
  await reader.read();
  expect(saved).toEqual(reader.data);
  expect(reader.records.some((r) => r.source === "release-state" && r.object === "save")).toBe(
    false,
  );
  replay.assertExhausted();
});

const treeCalls = (calls: string[]) => calls.filter((call) => call.includes("git/trees")).length;

test("legacy state without evidence records refreshes cached pins into records", async () => {
  const h = harness();
  h.store({
    at: START,
    releases: { [h.repo]: [RELEASE] },
    created: {},
    pins: { [h.key]: { lib: "old", java: "8" } },
    errors: {},
  });
  h.advance(RELEASES_EVERY_MS);
  await h.reader.read();
  expect(h.reader.data.pins[h.key]).toEqual({ java: "25", lib: "3.0.1" });
  expect(
    h.reader.records.find((r) => r.source === "github-pins" && r.object === h.key),
  ).toBeDefined();
  const count = treeCalls(h.calls);
  h.advance(RELEASES_EVERY_MS);
  await h.reader.read();
  expect(treeCalls(h.calls)).toBe(count);
});

test("force re-reads cached pins only when refreshPins is asked for", async () => {
  const h = harness();
  await h.reader.read();
  await h.reader.read({ force: true });
  expect(treeCalls(h.calls)).toBe(1);
  await h.reader.read({ force: true, refreshPins: true });
  expect(treeCalls(h.calls)).toBe(2);
});

test("a load failure record does not outlive a later successful load", async () => {
  const h = harness();
  const bad = new ReleaseReader(
    new Gh(new ReplayExec("")),
    {
      load: async () => ({ pins: 1 }),
      save: async () => {},
    },
    createContext({ fleet: fleetOf([]), clock: h.ctx.clock }),
  );
  await bad.read();
  expect(bad.records.some((r) => r.object === "load")).toBe(true);
  h.store({
    ...emptyState(),
    records: [
      {
        source: "release-state",
        object: "load",
        observedAt: START,
        completeness: { kind: "complete" },
        failure: "stale",
      },
    ],
  });
  await h.reader.read();
  expect(h.reader.records.some((r) => r.source === "release-state" && r.object === "load")).toBe(
    false,
  );
});

test("a creation-date failure uses the error whose path names its repository", async () => {
  const h = harness();
  const exec = {
    runText: async (_cmd: string, args: string[]) => {
      const query = args.find((arg) => arg.startsWith("query=")) ?? "";
      if (query.includes("createdAt")) {
        return {
          ok: true as const,
          data: JSON.stringify({
            data: {
              r0: null,
              spicodeBudget: { cost: 1, remaining: 9, resetAt: "2026-10-22T00:00:00Z" },
            },
            errors: [
              { message: "other repo", path: ["r9"] },
              { message: "this repo", path: ["r0"] },
            ],
          }),
          exitCode: 0,
        };
      }
      return { ok: true as const, data: "", exitCode: 0 };
    },
    runJSON: async () => ({ ok: true as const, data: [] }),
  };
  const reader = new ReleaseReader(
    new Gh(exec as never),
    { load: async () => undefined, save: async () => {} },
    h.ctx,
  );
  await reader.read();
  expect(reader.data.errors[`created:${h.ctx.fleet.releaseRepos[0]}`]).toBe("this repo");
  expect(reader.data.errors[`created:${h.ctx.fleet.releaseRepos[1]}`]).toBe(
    `${h.ctx.fleet.releaseRepos[1]} creation date not readable`,
  );
});
