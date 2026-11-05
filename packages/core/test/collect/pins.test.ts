// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import {
  emptyPinState,
  pinsOf,
  readForkPins,
  readLatest,
  readRemoval,
  readUpstreamPins,
} from "../../src/collect/pins.js";
import { fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { RecordingExec, ReplayExec } from "../../src/exec/index.js";
import { Gh, Glab, GraphqlBudget } from "../../src/forge.js";

const START = "2026-10-13T23:00:00.000Z";
const HOUR = 60 * 60_000;
const forks = [{ id: "service", repo: "test/service", azure: "provider/azure" }];
const blob = (version: string) => ({
  content: Buffer.from(`<core-lib-azure.version>${version}</core-lib-azure.version>`).toString(
    "base64",
  ),
});

function harness(route: (args: string[]) => unknown) {
  let time = Date.parse(START);
  const ctx = createContext({
    fleet: fleetOf([]),
    clock: { now: () => new Date(time) },
  });
  const calls: string[][] = [];
  const log: string[] = [];
  const exec = new RecordingExec(
    async (_cmd, args) => {
      calls.push(args);
      const data = route(args);
      return data instanceof Error
        ? { stdout: "", stderr: data.message, exit: 1 }
        : { stdout: JSON.stringify(data), stderr: "", exit: 0 };
    },
    (line) => {
      log.push(line);
    },
  );
  return {
    ctx,
    calls,
    log,
    gh: new Gh(exec, undefined, new GraphqlBudget(ctx.clock)),
    glab: new Glab(exec),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function gql(poms: unknown, errors: unknown[] = []) {
  return {
    data: {
      pom0: poms,
      spicodeBudget: {
        cost: 3,
        remaining: 1000,
        resetAt: "2026-10-14T00:00:00Z",
      },
    },
    errors,
  };
}

test("pins come from os-core-common.version and core-lib-azure.version, or the artifact's own version", () => {
  expect(
    pinsOf(
      "<properties>\n  <os-core-common.version>7.1.3</os-core-common.version>\n  <core-lib-azure.version>3.0.1</core-lib-azure.version>\n</properties>",
    ),
  ).toEqual({ osCoreCommon: "7.1.3", coreLibAzure: "3.0.1" });
  expect(
    pinsOf(
      "<dependency><groupId>org.opengroup.osdu</groupId><artifactId>core-lib-azure</artifactId>\n<version>3.0.4</version></dependency>",
    ),
  ).toEqual({ coreLibAzure: "3.0.4" });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Maven property reference, not a JS template.
  expect(pinsOf("<os-core-common.version>${core.version}</os-core-common.version>")).toEqual({});
});

test("fork blobs cache by oid, head changes refetch, and the recording replays with accounted GraphQL", async () => {
  let oid = "root1";
  const h = harness((args) =>
    args.includes("graphql")
      ? gql({ root: { oid }, azure: { oid: "azure1" } })
      : blob(args[1]?.endsWith("azure1") ? "3.0.4" : "3.0.1"),
  );
  const state = emptyPinState();
  const first = await readForkPins(h.gh, forks, state, h.ctx);
  expect(first.pins).toEqual({
    service: {
      root: { coreLibAzure: "3.0.1" },
      azure: { coreLibAzure: "3.0.4" },
    },
  });
  expect(first.reads).toHaveLength(2);
  await readForkPins(h.gh, forks, state, h.ctx);
  expect(h.calls.filter((args) => !args.includes("graphql"))).toHaveLength(2);
  oid = "root2";
  await readForkPins(h.gh, forks, state, h.ctx);
  expect(h.calls.filter((args) => !args.includes("graphql"))).toHaveLength(3);
  expect(h.gh.budget.snapshot().spent).toBe(9);

  const replay = new ReplayExec(h.log.join(""));
  const gh = new Gh(replay, undefined, new GraphqlBudget(h.ctx.clock));
  const replayState = emptyPinState();
  expect(await readForkPins(gh, forks, replayState, h.ctx)).toEqual(first);
  await readForkPins(gh, forks, replayState, h.ctx);
  await readForkPins(gh, forks, replayState, h.ctx);
  replay.assertExhausted();
  expect(gh.budget.snapshot().spent).toBe(9);
});

test("fork GraphQL errors affect only their field and retain the original value across repeated failures", async () => {
  let fail = false;
  const h = harness((args) =>
    args.includes("graphql")
      ? gql(
          { root: { oid: "r" }, azure: { oid: "a" } },
          fail ? [{ message: "root denied", path: ["pom0", "root"] }] : [],
        )
      : blob("3.0.1"),
  );
  const state = emptyPinState();
  await readForkPins(h.gh, forks, state, h.ctx);
  fail = true;
  for (let n = 0; n < 2; n++) {
    h.advance(HOUR);
    const read = await readForkPins(h.gh, forks, state, h.ctx);
    expect(read.pins.service?.root).toEqual({ coreLibAzure: "3.0.1" });
    expect(read.reads[0]).toMatchObject({ failure: "root denied", retainedFrom: START });
    expect(read.reads[1]?.failure).toBeUndefined();
  }
});

test("cold total outages record failures without inventing retention; empty fork lists do not call", async () => {
  const h = harness(() => new Error("offline"));
  const state = emptyPinState();
  expect(await readForkPins(h.gh, [], state, h.ctx)).toEqual({ pins: {}, reads: [] });
  expect(h.calls).toHaveLength(0);
  const fork = await readForkPins(h.gh, forks, state, h.ctx);
  const upstream = await readUpstreamPins(h.glab, "upstream/service", "head", state, h.ctx);
  const latest = await readLatest(h.glab, state, h.ctx);
  const removal = await readRemoval(h.glab, state, h.ctx);
  expect(fork.pins).toEqual({ service: {} });
  expect(upstream.pins).toBeUndefined();
  expect(latest.pins).toEqual({});
  expect(removal.removal).toBeUndefined();
  for (const record of [...fork.reads, ...upstream.reads, ...latest.reads, ...removal.reads]) {
    expect(record.failure).toBeTruthy();
    expect(record.retainedFrom).toBeUndefined();
  }
});

test("failed fork blobs retry rather than poisoning the oid cache; missing objects are failures", async () => {
  let mode = "fail";
  const h = harness((args) =>
    args.includes("graphql")
      ? gql({ root: mode === "missing" ? null : { oid: "root" } })
      : mode === "fail"
        ? new Error("blob denied")
        : blob("3.0.1"),
  );
  const state = emptyPinState();
  const roots = [{ id: "service", repo: "test/service" }];
  expect((await readForkPins(h.gh, roots, state, h.ctx)).reads[0]?.failure).toContain(
    "blob denied",
  );
  mode = "ok";
  expect((await readForkPins(h.gh, roots, state, h.ctx)).pins.service?.root).toEqual({
    coreLibAzure: "3.0.1",
  });
  mode = "missing";
  h.advance(HOUR);
  expect((await readForkPins(h.gh, roots, state, h.ctx)).reads[0]).toMatchObject({
    failure: "main:pom.xml is not readable",
    retainedFrom: START,
  });
});

test("upstream poms cache by project and head and failed heads retry after JSON round-trip", async () => {
  let fail = false;
  const h = harness(() => (fail ? new Error("pom unavailable") : blob("3.0.1")));
  let state = emptyPinState();
  expect(await readUpstreamPins(h.glab, "upstream/one", undefined, state, h.ctx)).toEqual({
    reads: [],
  });
  await readUpstreamPins(h.glab, "upstream/one", "head", state, h.ctx);
  h.advance(HOUR);
  expect(
    (await readUpstreamPins(h.glab, "upstream/one", "head", state, h.ctx)).reads[0]?.observedAt,
  ).toBe(new Date(Date.parse(START) + HOUR).toISOString());
  expect(h.calls).toHaveLength(1);
  await readUpstreamPins(h.glab, "upstream/two", "head", state, h.ctx);
  fail = true;
  expect(
    (await readUpstreamPins(h.glab, "upstream/one", "new", state, h.ctx)).reads[0]?.failure,
  ).toContain("pom unavailable");
  state = JSON.parse(JSON.stringify(state));
  fail = false;
  expect((await readUpstreamPins(h.glab, "upstream/one", "new", state, h.ctx)).pins).toEqual({
    coreLibAzure: "3.0.1",
  });
  expect(h.calls).toHaveLength(4);
});

test("cached pins carry the head read's retained evidence rather than making a stale head fresh", async () => {
  const h = harness(() => blob("3.0.1"));
  const state = emptyPinState();
  await readUpstreamPins(h.glab, "upstream/one", "head", state, h.ctx);
  h.advance(HOUR);
  const head = {
    source: "upstream/one",
    object: "repository/branches/master",
    observedAt: h.ctx.clock.now().toISOString(),
    retainedFrom: START,
    completeness: { kind: "complete" as const },
    failure: "head unread",
  };
  const result = await readUpstreamPins(h.glab, "upstream/one", "head", state, h.ctx, head);
  expect(result.pins).toEqual({ coreLibAzure: "3.0.1" });
  expect(result.reads[0]).toMatchObject({
    observedAt: head.observedAt,
    retainedFrom: START,
    failure: "head unread",
  });
  expect(h.calls).toHaveLength(1);
});

test("a failed removal read retries before the hourly cadence and only success starts its cadence", async () => {
  let fails = true;
  const h = harness(() => (fails ? new Error("offline") : []));
  const state = emptyPinState();
  await readRemoval(h.glab, state, h.ctx);
  expect(state.removalAt).toBeUndefined();
  fails = false;
  await readRemoval(h.glab, state, h.ctx);
  expect(state.removal?.record.failure).toBeUndefined();
  expect(state.removalAt).toBe(START);
  expect(h.calls).toHaveLength(3);
  await readRemoval(h.glab, state, h.ctx);
  expect(h.calls).toHaveLength(3);
});

test("the latest release is the newest semver tag and cadence uses the exact injected-clock boundary", async () => {
  const h = harness(() => [
    { name: "v8.4.0" },
    { name: "v9.3.0" },
    { name: "v9.10.0-rc1" },
    { name: "v9.2.0" },
  ]);
  const state = emptyPinState();
  const first = await readLatest(h.glab, state, h.ctx);
  expect(first.pins).toEqual({ osCoreCommon: "9.3.0", coreLibAzure: "9.3.0" });
  h.advance(HOUR - 1);
  expect(await readLatest(h.glab, state, h.ctx)).toEqual(first);
  expect(h.calls).toHaveLength(2);
  h.advance(1);
  const next = await readLatest(h.glab, state, h.ctx);
  expect(h.calls).toHaveLength(4);
  expect(next.reads.every((r) => r.observedAt === h.ctx.clock.now().toISOString())).toBe(true);
});

test("latest tags paginate and a single library failure retains only that library's original evidence", async () => {
  let fail = false;
  const h = harness((args) => {
    const path = args.at(-1) ?? "";
    if (fail && path.includes("os-core-common")) return new Error("tags denied");
    if (path.endsWith("page=1")) return Array.from({ length: 100 }, () => ({ name: "v1.0.0" }));
    return [{ name: fail ? "v10.0.0" : "v9.3.0" }];
  });
  let state = emptyPinState();
  expect((await readLatest(h.glab, state, h.ctx)).pins.osCoreCommon).toBe("9.3.0");
  state = JSON.parse(JSON.stringify(state));
  fail = true;
  for (let n = 0; n < 2; n++) {
    h.advance(HOUR);
    const result = await readLatest(h.glab, state, h.ctx);
    expect(result.pins).toEqual({ osCoreCommon: "9.3.0", coreLibAzure: "10.0.0" });
    expect(result.reads[0]).toMatchObject({ retainedFrom: START });
    expect(result.reads[0]?.failure).toContain("tags denied");
    expect(result.reads[1]?.retainedFrom).toBeUndefined();
    expect(result.reads[1]?.failure).toBeUndefined();
  }
});

test("a tag list without stable versions records failure instead of refreshing a previous release", async () => {
  let tags = [{ name: "v9.3.0" }];
  const h = harness(() => tags);
  const state = emptyPinState();
  await readLatest(h.glab, state, h.ctx);
  h.advance(HOUR);
  tags = [{ name: "v10.0.0-rc1" }, { name: "master" }];
  const retained = await readLatest(h.glab, state, h.ctx);
  expect(retained.pins).toEqual({ osCoreCommon: "9.3.0", coreLibAzure: "9.3.0" });
  expect(retained.reads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ failure: "No release tags are readable", retainedFrom: START }),
    ]),
  );
  tags = [];
  const cold = await readLatest(h.glab, emptyPinState(), h.ctx);
  expect(cold.pins).toEqual({});
  expect(cold.reads.every((r) => !!r.failure && r.retainedFrom === undefined)).toBe(true);
});

test("removal labels prefer established and failures keep the last due date and original retainedFrom", async () => {
  let fail = false;
  const issue = (full: string) => ({ references: { full }, milestone: { due_date: "2026-11-13" } });
  const h = harness((args) => {
    const path = args.at(-1) ?? "";
    if (path.includes("pending")) return [issue("upstream/storage#1"), issue("upstream/file#2")];
    return fail ? new Error("issues denied") : [issue("upstream/file#2")];
  });
  let state = emptyPinState();
  const first = await readRemoval(h.glab, state, h.ctx);
  expect(first.removal).toEqual({
    due: "2026-11-13",
    labels: { "upstream/storage": "pending", "upstream/file": "established" },
  });
  expect(h.calls[0]?.at(-1)).toContain(
    "groups/osdu%2Fplatform/issues?labels=SPI%20fork%3A%3Apending",
  );
  h.advance(HOUR - 1);
  expect(await readRemoval(h.glab, state, h.ctx)).toEqual(first);
  expect(h.calls).toHaveLength(2);
  h.advance(1);
  fail = true;
  for (let n = 0; n < 2; n++) {
    const result = await readRemoval(h.glab, state, h.ctx);
    expect(result.removal).toEqual(first.removal);
    expect(result.reads[0]).toMatchObject({
      retainedFrom: START,
      observedAt: h.ctx.clock.now().toISOString(),
    });
    expect(result.reads[0]?.failure).toContain("issues denied");
    state = JSON.parse(JSON.stringify(state));
    h.advance(HOUR);
  }
  fail = false;
  const recovered = await readRemoval(h.glab, state, h.ctx);
  expect(recovered.reads[0]?.failure).toBeUndefined();
  expect(recovered.reads[0]?.retainedFrom).toBeUndefined();
});
