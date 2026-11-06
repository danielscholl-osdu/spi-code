// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, expect, test, vi } from "vitest";
import {
  diffEntry,
  emptyRadarState,
  mrKey,
  pruneRadar,
  readRadar,
} from "../../src/collect/radar.js";
import { fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { envelopeOf } from "../../src/evidence/index.js";
import type { Exec } from "../../src/exec/index.js";
import { RecordingExec, ReplayExec } from "../../src/exec/recording.js";
import { Gh, Glab } from "../../src/forge.js";
import { parseFilter } from "../../src/model/filter.js";
import { diffVerdicts } from "../../src/model/radar.js";
import { FIXTURE_NOW, fixtureFacts } from "../harness.js";

const fork = { id: "partition", repo: "owner/partition", upstream: "osdu/partition" };
const ctx = createContext({ fleet: fleetOf([fork]), clock: { now: () => FIXTURE_NOW } });
const upstream = {
  partition: {
    service: "partition",
    commits: [{ sha: "q1", title: "add schemathesis", at: "2026-10-12T00:00:00Z", url: "u" }],
  },
};
const pom = [
  "--- a/pom.xml",
  "+++ b/pom.xml",
  "@@ -1 +1 @@",
  "-    <java.version>17</java.version>",
  "+    <java.version>25</java.version>",
].join("\n");
const mr = (iid: number) => ({
  iid,
  title: `MR ${iid}`,
  author: { username: "someone" },
  draft: iid === 2,
  labels: ["Azure"],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-12T00:00:00Z",
  sha: `head${iid}`,
  web_url: `https://gitlab/mr/${iid}`,
});

function recording(
  options: {
    many?: boolean;
    failList?: boolean;
    failFilter?: boolean;
    excluded?: { path: string; flag: "too_large" | "collapsed" };
    pins?: boolean;
    merged?: boolean;
  } = {},
) {
  const paths: string[] = [];
  let log = "";
  const exec = new RecordingExec(
    async (cmd, args) => {
      const path = args.at(-1) ?? "";
      paths.push(path);
      let data: unknown;
      if (options.pins && path.startsWith("query=") && cmd === "gh") {
        data = {
          data: {
            pom0: { root: { oid: "root-blob" }, azure: { oid: "azure-blob" } },
            spicodeBudget: { cost: 1, remaining: 4999, resetAt: "2099-01-01T00:00:00Z" },
          },
        };
      } else if (options.merged && path.startsWith("query=") && cmd === "glab") {
        data = {
          data: {
            p0: {
              mergeRequests: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    iid: "3",
                    title: "merged",
                    webUrl: "u",
                    mergedAt: FIXTURE_NOW.toISOString(),
                    diffHeadSha: "merged-head",
                  },
                ],
              },
            },
          },
        };
      } else if (options.pins && path.includes("/git/blobs/")) {
        const pom = path.endsWith("azure-blob")
          ? "<core-lib-azure.version>2.0.0</core-lib-azure.version>"
          : "<os-core-common.version>3.0.0</os-core-common.version>";
        data = { content: Buffer.from(pom).toString("base64") };
      } else if (options.pins && path.includes("/repository/tags?")) {
        data = [{ name: "v9.0.0" }];
      } else if (options.pins && path.includes("/issues?labels=")) {
        data = [
          { references: { full: "osdu/partition#1" }, milestone: { due_date: "2026-12-01" } },
        ];
      } else if (path.includes("/merge_requests?state=opened")) {
        if (!options.failList && !path.includes("broken")) {
          const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
          data = options.many
            ? Array.from({ length: page === 1 ? 100 : 3 }, (_, i) => mr((page - 1) * 100 + i + 1))
            : [mr(1), mr(2)];
        }
      } else if (path.includes("/merge_requests/") && path.includes("/diffs?")) {
        if (path.includes("/3/")) {
          data = [
            { old_path: "provider/obsolete", new_path: "provider/obsolete", deleted_file: true },
          ];
        } else if (!path.includes("/2/"))
          data = [
            {
              old_path: "pom.xml",
              new_path: "pom.xml",
              diff: pom,
            },
            { old_path: "old/a.java", new_path: "core/a.java", diff: "+x" },
          ];
      } else if (path.includes("/repository/commits/q1/diff")) {
        data = [{ old_path: "schemathesis-tests/run.sh", new_path: "schemathesis-tests/run.sh" }];
      } else if (path.endsWith("contents/.github/upstream-filter.yml") && !options.failFilter) {
        data = {
          sha: "blob1",
          content: Buffer.from(
            options.pins
              ? "fork_owned:\n  - provider/partition-azure\n"
              : "top_level:\n  docs: shared\n",
          ).toString("base64"),
        };
      }
      if (options.excluded && Array.isArray(data) && /\/diffs?\?/.test(path)) {
        const excluded = options.excluded;
        data = data
          .filter((d) => d.new_path !== excluded.path)
          .concat({
            old_path: excluded.path,
            new_path: excluded.path,
            deleted_file: true,
            [excluded.flag]: true,
          });
      }
      return data === undefined
        ? { stdout: "", stderr: `${cmd} ${path}: unavailable`, exit: 1 }
        : { stdout: JSON.stringify(data), stderr: "", exit: 0 };
    },
    (line) => {
      log += line;
    },
  );
  return { exec, paths, replay: () => new ReplayExec(log) };
}

afterEach(() => vi.useRealTimers());

test("cached diff envelopes replay unchanged and a failed filter keeps its last-good text and age", async () => {
  const state = emptyRadarState();
  const first = recording();
  await readRadar(new Gh(first.exec), new Glab(first.exec), upstream, state, ctx);
  const stored = structuredClone(state);
  const next = recording({ failFilter: true });
  const later = createContext({
    fleet: ctx.fleet,
    clock: { now: () => new Date(FIXTURE_NOW.getTime() + 60_000) },
  });
  const live = await readRadar(new Gh(next.exec), new Glab(next.exec), upstream, state, later);
  const replay = next.replay();
  const recorded = await readRadar(new Gh(replay), new Glab(replay), upstream, stored, later);
  expect(recorded.reads).toEqual(live.reads);
  expect(recorded.filters.partition).toEqual({
    sha: "blob1",
    text: "top_level:\n  docs: shared\n",
  });
  expect(recorded.reads.find((r) => r.object.endsWith("upstream-filter.yml"))).toMatchObject({
    failure: expect.stringContaining("unavailable"),
    retainedFrom: FIXTURE_NOW.toISOString(),
  });
  expect(recorded.reads.find((r) => r.object === "merge_requests/1/diffs")).toMatchObject({
    completeness: { kind: "complete" },
    observedAt: later.clock.now().toISOString(),
  });
});

test("MR fields, paths and pom lines survive replay; failed diffs stay unread, not empty", async () => {
  const run = async (exec: Exec) => {
    const result = await readRadar(new Gh(exec), new Glab(exec), upstream, emptyRadarState(), ctx);
    expect(result.services.partition?.mrs[0]).toEqual({
      iid: 1,
      title: "MR 1",
      author: "someone",
      draft: false,
      labels: ["Azure"],
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-12T00:00:00Z",
      headSha: "head1",
      url: "https://gitlab/mr/1",
      paths: ["pom.xml", "core/a.java", "old/a.java"],
      hunks: {
        "pom.xml": ["-    <java.version>17</java.version>", "+    <java.version>25</java.version>"],
      },
    });
    expect(result.services.partition?.mrs[1]).toMatchObject({ draft: true });
    expect(result.services.partition?.mrs[1]?.paths).toBeUndefined();
    expect(result.services.partition?.queued[0]?.paths).toEqual(["schemathesis-tests/run.sh"]);
    expect(result.filters.partition).toEqual({
      sha: "blob1",
      text: "top_level:\n  docs: shared\n",
    });
    expect(result.reads).toContainEqual(
      expect.objectContaining({
        source: fork.upstream,
        object: expect.stringContaining("/2/diffs"),
        failure: expect.stringContaining("unavailable"),
      }),
    );
    return result;
  };
  const recorded = recording();
  const expected = await run(recorded.exec);
  const replay = recorded.replay();
  expect(await run(replay)).toEqual(expected);
  replay.assertExhausted();
});

test("each diff is cached by immutable head or commit; failed reads are retried", async () => {
  const state = emptyRadarState();
  const first = recording();
  await readRadar(new Gh(first.exec), new Glab(first.exec), upstream, state, ctx);
  const again = recording();
  await readRadar(new Gh(again.exec), new Glab(again.exec), upstream, state, ctx);
  const diffs = (paths: string[]) => paths.filter((p) => /\/diffs?\?/.test(p));
  expect(diffs(first.paths)).toHaveLength(3);
  expect(diffs(again.paths)).toEqual([
    "projects/osdu%2Fpartition/merge_requests/2/diffs?per_page=100&page=1",
  ]);
});

test("merged MR caches without deletion information are refreshed", async () => {
  const context = createContext({
    fleet: fleetOf([{ ...fork, seeded: "2026-10-01" }]),
    clock: ctx.clock,
  });
  const state = emptyRadarState();
  const key = mrKey(fork.upstream, 3, "merged-head");
  state.mrDiffs[key] = { paths: ["stale"] };
  state.records[`mr:${key}`] = {
    source: fork.upstream,
    object: "merge_requests/3/diffs",
    observedAt: FIXTURE_NOW.toISOString(),
    completeness: { kind: "complete" },
  };
  const recorded = recording({ merged: true });
  const result = await readRadar(
    new Gh(recorded.exec),
    new Glab(recorded.exec),
    {},
    state,
    context,
  );
  expect(result.services.partition?.merged?.[0]).toMatchObject({
    paths: ["provider/obsolete"],
    deleted: ["provider/obsolete"],
  });
  expect(recorded.paths).toContain(
    "projects/osdu%2Fpartition/merge_requests/3/diffs?per_page=100&page=1",
  );
});

test("MR lists paginate through the forge until the short page", async () => {
  const recorded = recording({ many: true });
  const result = await readRadar(
    new Gh(recorded.exec),
    new Glab(recorded.exec),
    {},
    emptyRadarState(),
    ctx,
  );
  expect(result.services.partition?.mrs).toHaveLength(103);
  expect(recorded.paths.filter((p) => p.includes("/merge_requests?"))).toEqual([
    "projects/osdu%2Fpartition/merge_requests?state=opened&target_branch=master&per_page=100&page=1",
    "projects/osdu%2Fpartition/merge_requests?state=opened&target_branch=master&per_page=100&page=2",
  ]);
});

test("a failed MR list or filter is explicit and does not lose another fork's reads", async () => {
  const other = { ...fork, id: "broken", upstream: "osdu/broken", repo: "owner/broken" };
  const context = createContext({ fleet: fleetOf([fork, other]), clock: ctx.clock });
  const recorded = recording({ failFilter: true });
  const result = await readRadar(
    new Gh(recorded.exec),
    new Glab(recorded.exec),
    {},
    emptyRadarState(),
    context,
  );
  expect(Object.keys(result.services)).toEqual(["partition"]);
  expect(result.filters).toEqual({});
  expect(result.reads).toContainEqual(
    expect.objectContaining({
      source: "osdu/broken",
      failure: expect.stringContaining("unavailable"),
    }),
  );
  expect(result.reads).toContainEqual(
    expect.objectContaining({
      source: fork.repo,
      object: ".github/upstream-filter.yml",
      failure: expect.any(String),
    }),
  );
});

test.each(["too_large", "collapsed"] as const)(
  "%s non-hunk paths still Halt and their diffs are cached",
  async (flag) => {
    const state = emptyRadarState();
    const recorded = recording({ excluded: { path: "unlisted/run.sh", flag } });
    const result = await readRadar(
      new Gh(recorded.exec),
      new Glab(recorded.exec),
      upstream,
      state,
      ctx,
    );
    const service = result.services.partition;
    for (const diff of [service?.mrs[0], service?.queued[0]]) {
      expect(diff?.paths).toContain("unlisted/run.sh");
      expect(diffVerdicts(parseFilter("top_level:\n  docs: shared\n"), diff ?? {})).toContainEqual(
        expect.objectContaining({ bucket: "Halt", path: "unlisted/run.sh" }),
      );
    }
    const objects = ["merge_requests/1/diffs", "repository/commits/q1/diff"];
    expect(
      result.reads.filter((r) => objects.includes(r.object)).map((r) => r.completeness),
    ).toEqual([{ kind: "complete" }, { kind: "complete" }]);
    expect(state.mrDiffs[mrKey(fork.upstream, 1, "head1")]?.deleted).toContain("unlisted/run.sh");
    expect(state.commitDiffs.q1?.deleted).toContain("unlisted/run.sh");
    const warm = recording();
    await readRadar(new Gh(warm.exec), new Glab(warm.exec), upstream, state, ctx);
    expect(warm.paths.filter((p) => /\/diffs?\?/.test(p))).toEqual([
      "projects/osdu%2Fpartition/merge_requests/2/diffs?per_page=100&page=1",
    ]);
  },
);

test.each(["too_large", "collapsed"] as const)(
  "%s pom hunks are cut but all diff paths survive and are retried",
  async (flag) => {
    const state = emptyRadarState();
    const recorded = recording({ excluded: { path: "pom.xml", flag } });
    const result = await readRadar(
      new Gh(recorded.exec),
      new Glab(recorded.exec),
      upstream,
      state,
      ctx,
    );
    expect(result.services.partition?.mrs[0]?.paths).toEqual([
      "core/a.java",
      "old/a.java",
      "pom.xml",
    ]);
    expect(result.services.partition?.queued[0]?.paths).toEqual([
      "schemathesis-tests/run.sh",
      "pom.xml",
    ]);
    expect(result.services.partition?.mrs[0]?.hunks).toBeUndefined();
    expect(state.mrDiffs).toEqual({});
    expect(state.commitDiffs).toEqual({});
    for (const object of ["merge_requests/1/diffs", "repository/commits/q1/diff"]) {
      expect(result.reads).toContainEqual(
        expect.objectContaining({
          object,
          completeness: expect.objectContaining({ kind: "cut" }),
        }),
      );
    }
    const retry = recording();
    await readRadar(new Gh(retry.exec), new Glab(retry.exec), upstream, state, ctx);
    expect(retry.paths.filter((p) => /\/diffs?\?/.test(p))).toHaveLength(3);
  },
);

test("the radar area envelope aggregates cut diff reads across services", async () => {
  const legal = { id: "legal", repo: "owner/legal", upstream: "osdu/compliance/legal" };
  const two = createContext({ fleet: fleetOf([fork, legal]), clock: { now: () => FIXTURE_NOW } });
  const recorded = recording({ excluded: { path: "pom.xml", flag: "collapsed" } });
  const result = await readRadar(
    new Gh(recorded.exec),
    new Glab(recorded.exec),
    upstream,
    emptyRadarState(),
    two,
  );
  const cuts = result.reads.filter((r) => r.completeness.kind === "cut");
  expect(cuts.map((r) => `${r.source} ${r.object}`).sort()).toEqual([
    "osdu/compliance/legal merge_requests/1/diffs",
    "osdu/partition merge_requests/1/diffs",
    "osdu/partition repository/commits/q1/diff",
  ]);
  expect(
    envelopeOf(result.reads, { now: FIXTURE_NOW.getTime(), intervalMs: 60_000 }),
  ).toMatchObject({
    completeness: {
      kind: "cut",
      reason:
        "3 reads cut in legal, partition: GitLab omitted oversized or collapsed classification hunks",
      read: 3,
      total: 6,
    },
  });
});

test("cached read ages follow the context clock even when system time disagrees", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
  const state = emptyRadarState();
  const first = recording();
  await readRadar(new Gh(first.exec), new Glab(first.exec), upstream, state, ctx);
  const now = new Date(FIXTURE_NOW.getTime() + 3 * 60_000);
  const context = createContext({ fleet: ctx.fleet, clock: { now: () => now } });
  const again = recording();
  const result = await readRadar(
    new Gh(again.exec),
    new Glab(again.exec),
    upstream,
    state,
    context,
  );
  const cached = result.reads.find((r) => r.object === "merge_requests/1/diffs");
  expect(cached?.observedAt).toBe(now.toISOString());
  expect(now.getTime() - Date.parse(cached?.observedAt ?? "")).toBe(0);
  const immutableReads = result.reads.filter(
    (r) => r.object === "merge_requests/1/diffs" || r.object === "repository/commits/q1/diff",
  );
  expect(immutableReads).toHaveLength(2);
  expect(envelopeOf(immutableReads, { now: now.getTime(), intervalMs: 60_000 }).state).toBe(
    "fresh",
  );
  expect(state.records[`mr:${mrKey(fork.upstream, 1, "head1")}`]?.observedAt).toBe(
    now.toISOString(),
  );
  expect(state.records["commit:q1"]?.observedAt).toBe(now.toISOString());
  expect(again.paths.filter((p) => /\/diffs?\?/.test(p))).toHaveLength(1);
  expect(result.reads.find((r) => r.object.includes("state=opened"))?.observedAt).toBe(
    now.toISOString(),
  );
});

test("Radar composes pin readers on its context clock and retains their actual last-good time", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
  const state = emptyRadarState();
  const first = recording({ pins: true });
  const result = await readRadar(new Gh(first.exec), new Glab(first.exec), {}, state, ctx);
  expect(result.services.partition?.pins?.fork).toEqual({
    osCoreCommon: "3.0.0",
    coreLibAzure: "2.0.0",
  });
  expect(result.latest).toEqual({ osCoreCommon: "9.0.0", coreLibAzure: "9.0.0" });
  expect(result.removal).toEqual({
    due: "2026-12-01",
    labels: { "osdu/partition": "established" },
  });
  const now = new Date(FIXTURE_NOW.getTime() + 60 * 60_000);
  const context = createContext({ fleet: ctx.fleet, clock: { now: () => now } });
  const failure = recording();
  const retained = await readRadar(
    new Gh(failure.exec),
    new Glab(failure.exec),
    {},
    state,
    context,
  );
  expect(retained.latest).toEqual(result.latest);
  expect(retained.removal).toEqual(result.removal);
  const record = retained.reads.find((r) => r.object === "removal issues");
  expect(record).toMatchObject({
    observedAt: now.toISOString(),
    retainedFrom: FIXTURE_NOW.toISOString(),
    failure: expect.any(String),
  });
  expect(now.getTime() - Date.parse(record?.retainedFrom ?? "")).toBe(60 * 60_000);
});

test("diff entries retain rename paths and deletions but only classification hunks", () => {
  expect(
    diffEntry([
      { old_path: "old/pom.xml", new_path: "pom.xml", diff: pom },
      { old_path: "gone", new_path: "gone", deleted_file: true },
      { old_path: "a", new_path: "a", diff: "+not retained" },
      { old_path: ".fossa.yml", new_path: ".fossa.yml", diff: "+  modules:" },
    ]),
  ).toEqual({
    paths: ["pom.xml", "old/pom.xml", "gone", "a", ".fossa.yml"],
    deleted: ["gone"],
    hunks: {
      "pom.xml": ["-    <java.version>17</java.version>", "+    <java.version>25</java.version>"],
      ".fossa.yml": ["+  modules:"],
    },
  });
});

test("prune protects current MR, merged MR and queued diffs; unreferenced caches cap at 200", () => {
  const state = emptyRadarState();
  const facts = {
    services: {
      s: {
        project: "p",
        mrs: [{ ...mr(1), headSha: "h", author: "", createdAt: "", updatedAt: "", url: "" }],
        merged: [{ iid: 2, headSha: "m", title: "", mergedAt: "", url: "" }],
        queued: [{ sha: "kept", title: "", at: "", url: "" }],
      },
    },
    filters: { s: { sha: "blob1", text: "a" } },
  };
  for (let i = 0; i < 250; i++) {
    state.commitDiffs[`c${i}`] = { paths: [] };
    state.mrDiffs[`m${i}`] = { paths: [] };
    state.pins.poms[`p${i}`] = {};
  }
  state.commitDiffs.kept = { paths: [] };
  state.mrDiffs[mrKey("p", 1, "h")] = { paths: [] };
  state.mrDiffs[mrKey("p", 2, "m")] = { paths: [] };
  state.filters = { blob1: "a", stale: "b" };
  pruneRadar(state, facts);
  expect(Object.keys(state.commitDiffs)).toHaveLength(200);
  expect(Object.keys(state.mrDiffs)).toHaveLength(200);
  expect(state.commitDiffs.kept).toBeDefined();
  expect(state.mrDiffs[mrKey("p", 1, "h")]).toBeDefined();
  expect(state.mrDiffs[mrKey("p", 2, "m")]).toBeDefined();
  expect(Object.keys(state.filters)).toEqual(["blob1"]);
  expect(Object.keys(state.pins.poms)).toHaveLength(60);
  pruneRadar(state, undefined, 2);
  expect(Object.keys(state.commitDiffs)).toEqual(["c249", "kept"]);
});

test("the recorded frame holds every fixture fork's filters and halt-producing diffs", () => {
  const radar = fixtureFacts().radar.data;
  expect(Object.keys(radar?.filters ?? {}).sort()).toEqual(
    Object.keys(radar?.services ?? {}).sort(),
  );
  expect(
    radar?.services.entitlements?.queued.some((c) =>
      c.paths?.some((p) => p.startsWith("schemathesis-tests/")),
    ),
  ).toBe(true);
  expect(
    radar?.services.legal?.queued.some((c) =>
      c.hunks?.["pom.xml"]?.includes("+    <java.version>25</java.version>"),
    ),
  ).toBe(true);
  expect(
    Object.values(radar?.services ?? {})
      .flatMap((s) => s.mrs)
      .every((m) => /^upstream-author-\d+$/.test(m.author)),
  ).toBe(true);
});
