// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import {
  BODIES_PER_REPO,
  type OpenPrs,
  PULL_JQ,
  type ReleasePersist,
  ReleaseReader,
  releaseBodyKey,
  releaseStateSchema,
} from "../../src/collect/releases.js";
import { fleetOf, RELEASES_EVERY_MS, TEMPLATE_REPO } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { RecordingExec, ReplayExec } from "../../src/exec/index.js";
import { Gh } from "../../src/forge.js";
import { cacheSchema, emptyCache } from "../../src/sweep/cache.js";

const START = "2026-11-10T06:00:00.000Z";
const STORAGE = "test/storage";
const SEARCH = "test/search";
const sha = (c: string) => c.repeat(40);

interface Pull {
  state: "open" | "closed";
  sha: string;
  body: string | null;
}
/** A reply as gh's jq printed it, unchecked. */
interface RawPull {
  raw: unknown;
}

function pr(number: number, headSha: string, head = `release-please--branches--main--${number}`) {
  return { number, head, headSha, labels: [] as string[] };
}

function harness() {
  let time = Date.parse(START);
  const ctx = createContext({
    fleet: fleetOf([
      { id: "storage", repo: STORAGE, upstream: "upstream/storage" },
      { id: "search", repo: SEARCH, upstream: "upstream/search" },
    ]),
    clock: { now: () => new Date(time) },
  });
  let stored: unknown;
  const persist: ReleasePersist = {
    load: async () => stored,
    save: async (state) => {
      stored = structuredClone(state);
    },
  };
  const pulls = new Map<string, Pull | RawPull | Error>();
  const calls: string[] = [];
  const log: string[] = [];
  const exec = new RecordingExec(
    async (_cmd, args) => {
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (args.some((arg) => arg.startsWith("query="))) {
        const data = Object.fromEntries(
          ctx.fleet.releaseRepos.map((_, i) => [`r${i}`, { createdAt: START }]),
        );
        return { stdout: JSON.stringify({ data, errors: [] }), stderr: "", exit: 0 };
      }
      if (path.includes("/pulls/")) {
        calls.push(path);
        expect(args).toEqual(["api", path, "--jq", PULL_JQ]);
        const pull = pulls.get(path);
        if (pull === undefined || pull instanceof Error)
          return { stdout: "", stderr: pull?.message ?? `unrouted ${path}`, exit: 1 };
        if ("raw" in pull) return { stdout: JSON.stringify(pull.raw), stderr: "", exit: 0 };
        return {
          stdout: JSON.stringify({ state: pull.state, sha: pull.sha, body: pull.body ?? "" }),
          stderr: "",
          exit: 0,
        };
      }
      return { stdout: "", stderr: "", exit: 0 };
    },
    (line) => {
      log.push(line);
    },
  );
  const reader = new ReleaseReader(new Gh(exec), persist, ctx);
  return {
    ctx,
    reader,
    calls,
    log,
    stored: () => stored as Record<string, unknown> & { bodies: Record<string, unknown> },
    store: (value: unknown) => {
      stored = value;
    },
    pull: (repo: string, number: number, value: Pull | RawPull | Error) => {
      pulls.set(`repos/${repo}/pulls/${number}`, value);
    },
    advance: (ms: number) => {
      time += ms;
    },
    now: () => new Date(time).toISOString(),
  };
}

const CHANGELOG =
  "## [2.1.0](https://example.test/compare/v2.0.0...v2.1.0)\n\n### Features\n\n* add a synthetic endpoint\n";

test("two open release PRs persist two bodies, and an empty body is read, not missing", async () => {
  const h = harness();
  h.pull(STORAGE, 75, { state: "open", sha: sha("a"), body: CHANGELOG });
  h.pull(TEMPLATE_REPO, 263, { state: "open", sha: sha("t"), body: null });
  const open: OpenPrs = {
    [STORAGE]: { prs: [pr(75, sha("a")), pr(80, sha("d"), "dependabot/maven/x")] },
    [SEARCH]: { prs: [] },
    [TEMPLATE_REPO]: { prs: [pr(260, sha("m"), "feature/docs"), pr(263, sha("t"))] },
  };
  await h.reader.read({ force: true, openPrs: open });
  const bodies = {
    [releaseBodyKey(STORAGE, 75, sha("a"))]: {
      state: "read",
      repo: STORAGE,
      number: 75,
      sha: sha("a"),
      at: START,
      body: CHANGELOG,
    },
    [releaseBodyKey(TEMPLATE_REPO, 263, sha("t"))]: {
      state: "read",
      repo: TEMPLATE_REPO,
      number: 263,
      sha: sha("t"),
      at: START,
      body: "",
    },
  };
  expect(h.reader.data.bodies).toEqual(bodies);
  expect(h.stored().bodies).toEqual(bodies);
  expect(h.calls.sort()).toEqual(
    [`repos/${STORAGE}/pulls/75`, `repos/${TEMPLATE_REPO}/pulls/263`].sort(),
  );

  const replay = new ReplayExec(h.log.join(""));
  const again = new ReleaseReader(
    new Gh(replay),
    { load: async () => undefined, save: async () => {} },
    h.ctx,
  );
  await again.read({ force: true, openPrs: open });
  expect(again.data.bodies).toEqual(bodies);
  replay.assertExhausted();
});

test("a release PR is found by its autorelease label as well as its branch", async () => {
  const h = harness();
  h.pull(SEARCH, 76, { state: "open", sha: sha("s"), body: CHANGELOG });
  await h.reader.read({
    force: true,
    openPrs: {
      [SEARCH]: { prs: [{ ...pr(76, sha("s"), "custom"), labels: ["autorelease: pending"] }] },
    },
  });
  expect(Object.keys(h.reader.data.bodies)).toEqual([releaseBodyKey(SEARCH, 76, sha("s"))]);
});

test("a failed body read records not read for that PR only, and drops its earlier body", async () => {
  const h = harness();
  const open: OpenPrs = {
    [STORAGE]: { prs: [pr(75, sha("a"))] },
    [SEARCH]: { prs: [pr(76, sha("s"))] },
  };
  h.pull(STORAGE, 75, { state: "open", sha: sha("a"), body: CHANGELOG });
  h.pull(SEARCH, 76, { state: "open", sha: sha("s"), body: CHANGELOG });
  await h.reader.read({ force: true, openPrs: open });
  h.advance(RELEASES_EVERY_MS);
  h.pull(SEARCH, 76, new Error("HTTP 502: Bad Gateway"));
  await h.reader.read({ openPrs: open });
  expect(h.reader.data.bodies[releaseBodyKey(STORAGE, 75, sha("a"))]).toMatchObject({
    state: "read",
    body: CHANGELOG,
    at: h.now(),
  });
  const failed = h.reader.data.bodies[releaseBodyKey(SEARCH, 76, sha("s"))];
  expect(failed).toEqual({
    state: "not-read",
    repo: SEARCH,
    number: 76,
    sha: sha("s"),
    at: h.now(),
    reason: "failed",
    failure: expect.stringContaining("502"),
  });
  expect(failed).not.toHaveProperty("body");
  expect(h.stored().bodies).toEqual(h.reader.data.bodies);
});

test("a closed PR's body drops on the next read, as does a body for a head that moved", async () => {
  const h = harness();
  h.pull(STORAGE, 75, { state: "open", sha: sha("a"), body: CHANGELOG });
  h.pull(SEARCH, 76, { state: "open", sha: sha("s"), body: CHANGELOG });
  h.pull(TEMPLATE_REPO, 263, { state: "open", sha: sha("t"), body: CHANGELOG });
  await h.reader.read({
    force: true,
    openPrs: {
      [STORAGE]: { prs: [pr(75, sha("a"))] },
      [SEARCH]: { prs: [pr(76, sha("s"))] },
      [TEMPLATE_REPO]: { prs: [pr(263, sha("t"))] },
    },
  });
  expect(Object.keys(h.reader.data.bodies)).toHaveLength(3);

  h.advance(RELEASES_EVERY_MS);
  h.pull(SEARCH, 76, { state: "closed", sha: sha("s"), body: CHANGELOG });
  h.pull(TEMPLATE_REPO, 263, { state: "open", sha: sha("u"), body: `${CHANGELOG}* one more\n` });
  await h.reader.read({
    openPrs: {
      [STORAGE]: { prs: [] },
      [SEARCH]: { prs: [pr(76, sha("s"))] },
      [TEMPLATE_REPO]: { prs: [pr(263, sha("u"))] },
    },
  });
  expect(h.reader.data.bodies).toEqual({
    [releaseBodyKey(TEMPLATE_REPO, 263, sha("u"))]: {
      state: "read",
      repo: TEMPLATE_REPO,
      number: 263,
      sha: sha("u"),
      at: h.now(),
      body: `${CHANGELOG}* one more\n`,
    },
  });
  expect(h.stored().bodies).toEqual(h.reader.data.bodies);
});

test("a repo the PR list did not cover keeps its bodies; a repo gone from the fleet drops them", async () => {
  const h = harness();
  const kept = {
    state: "read",
    repo: STORAGE,
    number: 75,
    sha: sha("a"),
    at: START,
    body: CHANGELOG,
  } as const;
  const gone = { ...kept, repo: "test/retired", number: 9 };
  h.store({
    releases: {},
    created: {},
    pins: {},
    errors: {},
    records: [],
    shas: {},
    bodies: {
      [releaseBodyKey(STORAGE, 75, sha("a"))]: kept,
      [releaseBodyKey("test/retired", 9, sha("a"))]: gone,
    },
  });
  await h.reader.read({ force: true, openPrs: { [SEARCH]: { prs: [] } } });
  expect(h.reader.data.bodies).toEqual({ [releaseBodyKey(STORAGE, 75, sha("a"))]: kept });
  expect(h.calls).toEqual([]);
});

test("without the PR list the read leaves bodies as they were and reads none", async () => {
  const h = harness();
  h.pull(STORAGE, 75, { state: "open", sha: sha("a"), body: CHANGELOG });
  await h.reader.read({ force: true, openPrs: { [STORAGE]: { prs: [pr(75, sha("a"))] } } });
  const before = h.reader.data.bodies;
  h.advance(RELEASES_EVERY_MS);
  await h.reader.read();
  expect(h.reader.data.bodies).toEqual(before);
  expect(h.calls).toHaveLength(1);
});

test("requests per read are bounded: one per release PR, at most BODIES_PER_REPO per repo, none when not due", async () => {
  const h = harness();
  const flood = [1, 2, 3, 4, 5].map((n) => pr(n, sha(String(n))));
  for (const { number, headSha } of flood)
    h.pull(STORAGE, number, { state: "open", sha: headSha, body: CHANGELOG });
  h.pull(SEARCH, 76, { state: "open", sha: sha("s"), body: CHANGELOG });
  const open: OpenPrs = {
    [STORAGE]: { prs: [...flood, pr(80, sha("d"), "dependabot/maven/x")] },
    [SEARCH]: { prs: [pr(76, sha("s"))] },
    [TEMPLATE_REPO]: { prs: [] },
  };
  await h.reader.read({ force: true, openPrs: open });
  expect(h.calls).toHaveLength(BODIES_PER_REPO + 1);
  expect(h.calls.length).toBeLessThanOrEqual(BODIES_PER_REPO * h.ctx.fleet.projectRepos.length);
  expect(new Set(h.calls).size).toBe(h.calls.length);
  const states = Object.values(h.reader.data.bodies).map((b) => [b.repo, b.number, b.state]);
  expect(states.sort()).toEqual([
    [SEARCH, 76, "read"],
    [STORAGE, 1, "read"],
    [STORAGE, 2, "read"],
    [STORAGE, 3, "not-read"],
    [STORAGE, 4, "not-read"],
    [STORAGE, 5, "not-read"],
  ]);
  expect(h.reader.data.bodies[releaseBodyKey(STORAGE, 3, sha("3"))]).toMatchObject({
    reason: "over-cap",
    failure: `over ${BODIES_PER_REPO} release PRs read per repository`,
  });

  h.calls.length = 0;
  h.advance(RELEASES_EVERY_MS - 1);
  await h.reader.read({ openPrs: open });
  expect(h.calls).toEqual([]);
  h.advance(1);
  await h.reader.read({ openPrs: open });
  expect(h.calls).toHaveLength(BODIES_PER_REPO + 1);
});

// The shape main saved before bodies existed, as the sweep cache holds it.
const MAIN_STATE = {
  at: "2026-11-09T22:00:00.000Z",
  releases: { [STORAGE]: [{ tag: "v2.0.0", at: "2026-11-01T00:00:00Z", body: "" }] },
  created: { [STORAGE]: "2025-01-01T00:00:00Z" },
  pins: { [`${STORAGE}@v2.0.0`]: { lib: "2.5.10", java: "17" } },
  errors: {},
  records: [
    {
      source: "github-releases",
      object: STORAGE,
      observedAt: "2026-11-09T22:00:00.000Z",
      completeness: { kind: "complete" },
    },
  ],
  shas: { [`${STORAGE}@v2.0.0`]: sha("a") },
};

test("a release state file from main loads with no bodies, and its next read adds them", async () => {
  expect(releaseStateSchema.parse(MAIN_STATE)).toEqual({ ...MAIN_STATE, bodies: {} });
  const { bodies: _, ...mainCache } = { ...emptyCache().releases };
  expect(
    cacheSchema.parse({ ...emptyCache(), releases: { ...mainCache, ...MAIN_STATE } }).releases
      .bodies,
  ).toEqual({});

  const h = harness();
  h.store(structuredClone(MAIN_STATE));
  h.pull(STORAGE, 75, { state: "open", sha: sha("a"), body: CHANGELOG });
  await h.reader.read({ force: true, openPrs: { [STORAGE]: { prs: [pr(75, sha("a"))] } } });
  expect(h.reader.records.find((r) => r.source === "release-state")).toBeUndefined();
  expect(h.reader.data.pins).toEqual(MAIN_STATE.pins);
  expect(Object.keys(h.reader.data.bodies)).toEqual([releaseBodyKey(STORAGE, 75, sha("a"))]);
});

const ENTRY = { repo: STORAGE, number: 75, sha: sha("a"), at: START } as const;
const KEY = releaseBodyKey(STORAGE, 75, sha("a"));
const GOOD = { ...ENTRY, state: "read", body: CHANGELOG } as const;

test("a malformed stored body drops alone as not read, and the rest of the state loads", async () => {
  const bad = [
    { ...ENTRY, state: "read" },
    { ...ENTRY, state: "not-read", failure: "x" },
    { ...ENTRY, state: "not-read", reason: "failed" },
    { ...ENTRY, body: "" },
    { ...ENTRY, state: "read", sha: null, body: "" },
    "not an entry",
  ];
  const other = releaseBodyKey(SEARCH, 76, sha("s"));
  const good = { ...GOOD, repo: SEARCH, number: 76, sha: sha("s") };
  for (const entry of bad) {
    const state = { ...MAIN_STATE, bodies: { [KEY]: entry, [other]: good } };
    expect(releaseStateSchema.parse(state)).toEqual({ ...MAIN_STATE, bodies: { [other]: good } });
    expect(cacheSchema.parse({ ...emptyCache(), releases: state }).releases.bodies).toEqual({
      [other]: good,
    });
  }
  const notRead = { ...ENTRY, state: "not-read", reason: "over-cap", failure: "x" };
  expect(releaseStateSchema.parse({ ...MAIN_STATE, bodies: { [KEY]: notRead } }).bodies).toEqual({
    [KEY]: notRead,
  });

  const h = harness();
  h.store({ ...structuredClone(MAIN_STATE), at: START, bodies: { [KEY]: bad[0], [other]: good } });
  await h.reader.read({ openPrs: {} });
  expect(h.calls).toEqual([]);
  expect(h.reader.records.find((r) => r.source === "release-state")).toBeUndefined();
  expect(h.reader.data.pins).toEqual(MAIN_STATE.pins);
  expect(h.reader.data.releases).toEqual(MAIN_STATE.releases);
  expect(h.reader.data.bodies).toEqual({ [other]: good });
});

test("a stored body filed under a key other than its own repo, number and head drops on load", () => {
  const parse = (key: string) =>
    releaseStateSchema.parse({ ...MAIN_STATE, bodies: { [key]: GOOD } }).bodies;
  expect(parse(KEY)).toEqual({ [KEY]: GOOD });
  expect(parse(releaseBodyKey(STORAGE, 75, sha("b")))).toEqual({});
  expect(parse(releaseBodyKey(STORAGE, 76, sha("a")))).toEqual({});
  expect(parse(releaseBodyKey(SEARCH, 75, sha("a")))).toEqual({});
  expect(parse("k")).toEqual({});
});

test("a body reply without a string head, body or state records not read and saves", async () => {
  const replies = [
    { state: "open", sha: null, body: CHANGELOG },
    { state: "open", sha: sha("a"), body: 7 },
    { sha: sha("a"), body: CHANGELOG },
    { state: "open", sha: "", body: CHANGELOG },
    { state: "", sha: sha("a"), body: CHANGELOG },
    [],
  ];
  for (const raw of replies) {
    const h = harness();
    h.pull(STORAGE, 75, { raw });
    await h.reader.read({ force: true, openPrs: { [STORAGE]: { prs: [pr(75, sha("a"))] } } });
    expect(h.reader.data.bodies).toEqual({
      [KEY]: {
        ...ENTRY,
        state: "not-read",
        reason: "failed",
        failure: expect.stringContaining(`${STORAGE}#75`),
      },
    });
    expect(h.stored().bodies).toEqual(h.reader.data.bodies);
    expect(cacheSchema.parse({ ...emptyCache(), releases: h.stored() }).releases.bodies).toEqual(
      h.reader.data.bodies,
    );
  }
});

test("a body is keyed by the head its read returned, not the head the PR list gave", async () => {
  const h = harness();
  h.pull(STORAGE, 75, { state: "open", sha: sha("b"), body: CHANGELOG });
  await h.reader.read({ force: true, openPrs: { [STORAGE]: { prs: [pr(75, sha("a"))] } } });
  expect(h.reader.data.bodies).toEqual({
    [releaseBodyKey(STORAGE, 75, sha("b"))]: { ...GOOD, sha: sha("b") },
  });
  expect(h.reader.data.bodies[KEY]).toBeUndefined();
});

test("past the cap no release PR starves: the newest always, then unread, then least recently read", async () => {
  const h = harness();
  const prs = [9, 8, 7, 6].map((n) => pr(n, sha(String(n))));
  for (const { number, headSha } of prs)
    h.pull(STORAGE, number, { state: "open", sha: headSha, body: `${CHANGELOG}#${number}` });
  const open: OpenPrs = { [STORAGE]: { prs } };
  const key = (n: number) => releaseBodyKey(STORAGE, n, sha(String(n)));
  const round = async () => {
    h.calls.length = 0;
    await h.reader.read({ openPrs: open });
    h.advance(RELEASES_EVERY_MS);
    return h.calls.map((c) => Number(c.split("/").at(-1))).sort();
  };

  const first = h.now();
  expect(await round()).toEqual([8, 9]);
  expect(h.reader.data.bodies[key(7)]).toMatchObject({ state: "not-read", reason: "over-cap" });
  expect(h.reader.data.bodies[key(6)]).toMatchObject({ state: "not-read", reason: "over-cap" });

  const second = h.now();
  expect(await round()).toEqual([7, 9]);
  expect(h.reader.data.bodies[key(8)]).toMatchObject({ state: "read", at: first });
  expect(h.reader.data.bodies[key(7)]).toMatchObject({ state: "read", at: second });
  expect(h.reader.data.bodies[key(6)]).toMatchObject({ state: "not-read", reason: "over-cap" });

  expect(await round()).toEqual([6, 9]);
  expect(await round()).toEqual([8, 9]);
  expect(await round()).toEqual([7, 9]);
  expect(await round()).toEqual([6, 9]);
  expect(Object.values(h.reader.data.bodies).map((b) => b.state)).toEqual([
    "read",
    "read",
    "read",
    "read",
  ]);
});

test("a release PR whose body read always fails does not hold the second slot", async () => {
  const h = harness();
  const prs = [9, 8, 7].map((n) => pr(n, sha(String(n))));
  h.pull(STORAGE, 9, { state: "open", sha: sha("9"), body: CHANGELOG });
  h.pull(STORAGE, 8, new Error("HTTP 502: Bad Gateway"));
  h.pull(STORAGE, 7, { state: "open", sha: sha("7"), body: CHANGELOG });
  const open: OpenPrs = { [STORAGE]: { prs } };
  const round = async () => {
    h.calls.length = 0;
    await h.reader.read({ openPrs: open });
    h.advance(RELEASES_EVERY_MS);
    return h.calls.map((c) => Number(c.split("/").at(-1))).sort();
  };
  expect(await round()).toEqual([8, 9]);
  expect(h.reader.data.bodies[releaseBodyKey(STORAGE, 8, sha("8"))]).toMatchObject({
    state: "not-read",
    reason: "failed",
  });
  expect(await round()).toEqual([7, 9]);
  expect(h.reader.data.bodies[releaseBodyKey(STORAGE, 7, sha("7"))]).toMatchObject({
    state: "read",
  });
  expect(await round()).toEqual([8, 9]);
  expect(await round()).toEqual([7, 9]);
});

test("a bodies field that is not an object loads as no bodies, and the rest of the state stands", () => {
  for (const bodies of ["x", 7, null, [], true]) {
    const state = { ...MAIN_STATE, bodies };
    expect(releaseStateSchema.parse(state)).toEqual({ ...MAIN_STATE, bodies: {} });
    expect(cacheSchema.parse({ ...emptyCache(), releases: state }).releases).toEqual({
      ...MAIN_STATE,
      bodies: {},
    });
  }
});
