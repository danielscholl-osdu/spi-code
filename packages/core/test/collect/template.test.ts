// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  changeOf,
  firstParentChanges,
  readTemplate,
  TEMPLATE_COMPARE_PAGES,
} from "../../src/collect/template.js";
import { fleetOf, TEMPLATE_REPO } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { Exec } from "../../src/exec/index.js";
import { RecordingExec, ReplayExec } from "../../src/exec/recording.js";
import type { RepoFact } from "../../src/facts.js";
import { Gh } from "../../src/forge.js";

const now = "2026-10-13T18:00:00.000Z";
const fork = { id: "custom", repo: "example/custom", upstream: "custom" };
const ctx = (time = now, forks = [fork]) =>
  createContext({
    fleet: fleetOf(forks),
    clock: { now: () => new Date(time) },
  });
const commit = (sha: string, parents: string[], message: string) => ({
  sha,
  parents,
  message,
  date: "2026-10-10T16:12:46Z",
  url: `https://github.com/Azure/osdu-spi/commit/${sha}`,
});
const repo = (name: string): RepoFact => ({
  repo: name,
  url: "",
  prs: [],
  issues: [],
  deployments: [],
});
function repos(head = "head", marker = "marker", tag?: string): Record<string, RepoFact> {
  return {
    [TEMPLATE_REPO]: {
      ...repo(TEMPLATE_REPO),
      head: { sha: head, at: now },
      ...(tag ? { release: { tag, at: now, url: "" } } : {}),
    },
    [fork.repo]: { ...repo(fork.repo), marker },
  };
}
const compare = (
  commits = [commit("head", ["marker"], "fix: main (#251)")],
  total = commits.length,
) => ({
  status: "ahead",
  ahead_by: total,
  behind_by: 0,
  total_commits: total,
  commits,
});
function routed(route: (path: string, jq: string | undefined) => unknown) {
  const calls: string[] = [];
  const exec: Exec = {
    runJSON: async <T>(_cmd: string, args: string[]) => {
      const path = args[1] ?? "";
      calls.push(path);
      const value = route(path, args[3]);
      return value instanceof Error
        ? { ok: false, error: value.message, code: 1 }
        : { ok: true, data: value as T };
    },
    runText: async (_cmd, args) => {
      const path = args[2] ?? "";
      calls.push(path);
      const value = route(path, args[4]);
      return value instanceof Error
        ? { ok: false, error: value.message, code: 1 }
        : { ok: true, data: JSON.stringify(value) };
    },
  };
  return { exec, calls };
}
const baseRoute = (path: string) =>
  path.includes("/contents/")
    ? { dirs: [".github"], files: ["pom.xml"] }
    : path.includes("?per_page=100&page=")
      ? compare()
      : ["pom.xml"];

describe("template changes (rib collect.test.ts)", () => {
  test("a merge commit carries its PR title; a squash keeps its subject and number", () => {
    expect(
      changeOf(
        commit(
          "m1",
          ["a", "b"],
          "Merge pull request #251 from Azure/copilot/x\n\nPin Maven in java-build",
        ),
      ),
    ).toMatchObject({
      title: "Pin Maven in java-build",
      pr: 251,
      url: "https://github.com/Azure/osdu-spi/pull/251",
    });
    expect(changeOf(commit("s1", ["a"], "fix(build): pin maven (#251)"))).toMatchObject({
      title: "fix(build): pin maven (#251)",
      pr: 251,
    });
  });

  test("only main's first-parent chain counts as changes", () => {
    const commits = [
      commit("side1", ["marker"], "Initial plan"),
      commit("side2", ["side1"], "Apply remaining changes"),
      commit(
        "m1",
        ["marker", "side2"],
        "Merge pull request #251 from Azure/copilot/x\n\nPin Maven",
      ),
      commit(
        "m2",
        ["m1", "dep1"],
        "Merge pull request #252 from Azure/dependabot/y\n\nchore(deps): bump openjdk",
      ),
      commit("dep1", ["marker"], "chore(deps): bump openjdk"),
    ];
    expect(firstParentChanges("m2", commits).map((c) => c.pr)).toEqual([252, 251]);
  });
});

test("a commit is named by the newest release it contains, even from a cached compare (rib)", async () => {
  const marker = "ea9a2e10000000000000000000000000000000000";
  const target = "bb49a030000000000000000000000000000000000";
  const input = repos("head", marker, "v1.3.0");
  input[fork.repo]?.prs.push({
    number: 1,
    title: "",
    url: "",
    author: "",
    draft: false,
    head: "sync",
    base: "main",
    headMarker: target,
    labels: [],
    checks: [],
    repo: fork.repo,
    createdAt: now,
    updatedAt: now,
    headSha: "pr-head",
  });
  const fake = routed((path) => {
    if (path.includes("/tags?")) return ["v1.2.0", "v1.3.0", "v1.1.0"];
    if (path.includes("?per_page=100&page=")) return compare([], 0);
    if (path.includes("/contents/")) return { dirs: [], files: [] };
    const key = path.split("/compare/")[1];
    const values: Record<string, { status: string; ahead_by: number }> = {
      [`v1.3.0...${marker}`]: { status: "behind", ahead_by: 0 },
      [`v1.2.0...${marker}`]: { status: "identical", ahead_by: 0 },
      [`v1.3.0...${target}`]: { status: "behind", ahead_by: 0 },
      [`v1.2.0...${target}`]: { status: "ahead", ahead_by: 14 },
      "v1.3.0...head": { status: "identical", ahead_by: 0 },
    };
    return key && values[key] ? { ...values[key], behind_by: 0 } : new Error(`no fake for ${path}`);
  });
  const gh = new Gh(fake.exec);
  const first = await readTemplate(ctx(), gh, input);
  const second = await readTemplate(ctx("2026-10-14T18:00:00.000Z"), gh, input, first.state, first);
  expect(second.compares[marker]?.label).toBe("v1.2.0");
  expect(second.targets?.[target]).toBe("v1.2.0 +14");
  expect(second.mainAhead).toBe(0);
  expect(second.reads.every((r) => r.observedAt === now && !r.failure)).toBe(true);
  expect(fake.calls.filter((p) => p.includes("/tags"))).toHaveLength(1);
  expect(fake.calls.filter((p) => p.includes(`v1.2.0...${marker}`))).toHaveLength(1);
});

test("an Exec recording replays the template facts, sync paths and file reads", async () => {
  let log = "";
  const recording = new RecordingExec(
    async (_cmd, args) => ({
      stdout: JSON.stringify(baseRoute(args[1] ?? "")),
      stderr: "",
      exit: 0,
    }),
    (line) => {
      log += line;
    },
  );
  const result = await readTemplate(ctx(), new Gh(recording), repos());
  const replay = new ReplayExec(log);
  expect(await readTemplate(ctx(), new Gh(replay), repos())).toEqual(result);
  replay.assertExhausted();
  expect(result.compares.marker?.changes.map((c) => c.pr)).toEqual([251]);
  expect(result.files).toEqual({ head: ["pom.xml"] });
  expect(result.synced).toEqual({ dirs: [".github"], files: ["pom.xml"] });
});

test("compares read every page and the commit walk at its page limit is explicitly cut", async () => {
  const fake = routed((path) => {
    if (!path.includes("?per_page=100&page=")) return baseRoute(path);
    const page = Number(new URL(`https://api.github.com/${path}`).searchParams.get("page"));
    return compare(
      page === 2
        ? [commit("head", ["middle"], "fix")]
        : [
            commit("middle", ["marker"], "fix"),
            ...Array.from({ length: 99 }, (_, i) => commit(`side-${i}`, [], "fix")),
          ],
      101,
    );
  });
  const full = await readTemplate(ctx(), new Gh(fake.exec), repos());
  expect(full.compares.marker?.changes.map((c) => c.sha)).toEqual(["head", "middle"]);
  expect(full.reads.find((r) => r.object.endsWith("marker...head"))?.completeness.kind).toBe(
    "complete",
  );

  const cut = routed((path) =>
    path.includes("?per_page=100&page=")
      ? compare(
          Array.from({ length: 100 }, (_, i) =>
            commit(
              `page-${new URL(`https://api.github.com/${path}`).searchParams.get("page")}-${i}`,
              [],
              "fix",
            ),
          ),
          TEMPLATE_COMPARE_PAGES * 100 + 1,
        )
      : baseRoute(path),
  );
  const partial = await readTemplate(ctx(), new Gh(cut.exec), repos());
  expect(cut.calls.filter((p) => p.includes("?per_page=100&page="))).toHaveLength(
    TEMPLATE_COMPARE_PAGES,
  );
  expect(partial.reads.find((r) => r.object.endsWith("marker...head"))?.completeness).toMatchObject(
    { kind: "cut", read: TEMPLATE_COMPARE_PAGES * 100, total: TEMPLATE_COMPARE_PAGES * 100 + 1 },
  );
  const recovered = await readTemplate(
    ctx(),
    new Gh(routed(baseRoute).exec),
    repos(),
    partial.state,
    partial,
  );
  expect(recovered.compares.marker?.changes.map((c) => c.pr)).toEqual([251]);
  expect(recovered.reads.find((r) => r.object.endsWith("marker...head"))?.completeness.kind).toBe(
    "complete",
  );
});

test("repeated failed compares retain the previous changes and original observedAt", async () => {
  const good = await readTemplate(ctx(), new Gh(routed(baseRoute).exec), repos());
  const bad = new Gh(routed(() => new Error("offline")).exec);
  const failed = await readTemplate(
    ctx("2026-10-14T18:00:00.000Z"),
    bad,
    repos("next"),
    good.state,
    good,
  );
  const again = await readTemplate(
    ctx("2026-10-15T18:00:00.000Z"),
    bad,
    repos("next"),
    failed.state,
    failed,
  );
  expect(again.compares.marker).toEqual(good.compares.marker);
  expect(again.synced).toEqual(good.synced);
  expect(again.reads.find((r) => r.object.endsWith("marker...next"))).toMatchObject({
    failure: expect.stringContaining("offline"),
    retainedFrom: now,
    observedAt: "2026-10-15T18:00:00.000Z",
  });
});

test("fleet markers and targets are isolated, and missing template heads cause no reads", async () => {
  const fake = routed(baseRoute);
  const input = repos();
  const empty = await readTemplate(ctx(now, []), new Gh(fake.exec), input);
  expect(empty.compares).toEqual({});
  expect(fake.calls.some((p) => p.includes("marker..."))).toBe(false);
  const other = await readTemplate(ctx(), new Gh(fake.exec), input);
  expect(Object.keys(other.compares)).toEqual(["marker"]);
  const before = fake.calls.length;
  expect((await readTemplate(ctx(), new Gh(fake.exec), {})).reads).toEqual([]);
  expect(fake.calls).toHaveLength(before);
});

test("invalid saved state is discarded with failure evidence; capped files are incomplete", async () => {
  const fake = routed((path) =>
    path.includes("/compare/") && !path.includes("?per_page=")
      ? Array.from({ length: 300 }, (_, i) => `file-${i}`)
      : baseRoute(path),
  );
  const result = await readTemplate(ctx(), new Gh(fake.exec), repos(), {
    invalid: { value: "bad" },
  });
  expect(result.reads.find((r) => r.source === "persist")?.failure).toBeTruthy();
  expect(result.reads.find((r) => r.object.startsWith("files:"))?.completeness.kind).toBe("cut");
});

test("an early empty page fails explicitly, with no retainedFrom on a cold read", async () => {
  const fake = routed((path) =>
    path.includes("?per_page=100&page=") ? compare([], 1) : baseRoute(path),
  );
  const result = await readTemplate(ctx(), new Gh(fake.exec), repos());
  expect(result.compares).toEqual({});
  expect(result.reads.find((r) => r.object.endsWith("marker...head"))).toMatchObject({
    failure: "Template compare ended before total_commits",
  });
  expect(result.reads.find((r) => r.failure)?.retainedFrom).toBeUndefined();
});
