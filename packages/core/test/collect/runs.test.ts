// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { readApprovals, readForkRuns, readTemplateRuns } from "../../src/collect/runs.js";
import { fleetOf, STACK_REPO as STACK } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { envelopeOf } from "../../src/evidence/index.js";
import { RecordingExec, ReplayExec } from "../../src/exec/recording.js";
import { Gh } from "../../src/forge.js";
import { FIXTURE_NOW } from "../harness.js";

const ctx = (ids: string[] = []) =>
  createContext({
    fleet: fleetOf(ids.map((id) => ({ id, repo: `test/${id}`, upstream: `osdu/${id}` }))),
    clock: { now: () => FIXTURE_NOW },
  });
const raw = (id = 1, sha = "541ab075615710332d1212659f536d027e6c72c3") => ({
  id,
  name: "CodeQL",
  path: ".github/workflows/codeql.yml",
  event: "pull_request",
  status: "completed",
  conclusion: "action_required",
  created_at: "2026-10-12T20:01:49Z",
  updated_at: "2026-10-12T20:01:49Z",
  head_branch: null,
  head_sha: sha,
  display_title: "fix(k8s): Harden Reference Catalog Downloads",
  html_url: `https://github.com/${STACK}/actions/runs/${id}`,
  run_attempt: 1,
});
const pr = (number = 343, sha = raw().head_sha) => ({
  number,
  title: raw().display_title,
  url: `https://github.com/${STACK}/pull/${number}`,
  author: "contributor-a",
  association: "CONTRIBUTOR",
  draft: false,
  sha,
});
const files = [{ path: ".github/workflows/validate.yml" }, { path: "k8s/reference/download.sh" }];
type Handler = (path: string) => unknown;

async function replay<T>(read: (gh: Gh) => Promise<T>, fixture: Handler): Promise<T> {
  let log = "";
  const recorded = new RecordingExec(
    async (_cmd, args) => {
      const path = args[args.includes("--paginate") ? 2 : 1] ?? "";
      const value = fixture(path);
      if (value instanceof Error) return { stdout: "", stderr: value.message, exit: 1 };
      const stdout = args.includes("--paginate")
        ? (value as unknown[]).map((v) => JSON.stringify(v)).join("\n")
        : JSON.stringify(value);
      return { stdout, stderr: "", exit: 0 };
    },
    (line) => {
      log += line;
    },
  );
  const expected = await read(new Gh(recorded));
  const exec = new ReplayExec(log);
  const result = await read(new Gh(exec));
  expect(result).toEqual(expected);
  exec.assertExhausted();
  return result;
}

function approvals(path: string): unknown {
  if (path.includes("/actions/runs")) {
    return { total: path.includes(STACK) ? 1 : 0, runs: path.includes(STACK) ? [raw()] : [] };
  }
  if (path.includes("pulls?")) return [pr()];
  if (path.includes("/files?")) return files;
  if (path.endsWith("/343")) return { changed: 2, additions: 90, deletions: 12 };
  throw new Error(`Unexpected fixture request: ${path}`);
}

test("template run replay preserves conversion, nulls and the bounded history's evidence", async () => {
  const result = await replay(
    (gh) => readTemplateRuns(gh, STACK, ctx()),
    (path) => {
      expect(path).toBe(`repos/${STACK}/actions/workflows/sync-template.yml/runs?per_page=5`);
      return {
        total: 8,
        runs: Array.from({ length: 5 }, (_, i) => ({ ...raw(i), conclusion: null })),
      };
    },
  );
  expect(result.data[0]).toEqual({
    id: 0,
    name: "CodeQL",
    path: raw().path,
    event: "pull_request",
    status: "completed",
    conclusion: undefined,
    createdAt: raw().created_at,
    updatedAt: raw().updated_at,
    branch: undefined,
    sha: raw().head_sha,
    title: raw().display_title,
    url: raw(0).html_url,
    attempt: 1,
  });
  expect(result.reads[0]).toMatchObject({
    source: STACK,
    observedAt: FIXTURE_NOW.toISOString(),
    completeness: { kind: "cut", read: 5, total: 8 },
  });
});

test("fork run failure is isolated, and two interleaved fleets use only their own repositories", async () => {
  const first = ctx(["good", "broken"]);
  const second = ctx(["other"]);
  const results = await replay(
    (gh) => Promise.all([readForkRuns(gh, first), readForkRuns(gh, second)]),
    (path) => {
      expect(path).toMatch(/^repos\/test\/(good|broken|other)\/actions\/workflows\//);
      return path.includes("/broken/") ? new Error("offline") : { total: 1, runs: [raw()] };
    },
  );
  expect(Object.keys(results[0].data)).toEqual(["test/good"]);
  expect(Object.keys(results[1].data)).toEqual(["test/other"]);
  expect(Object.values(results[0].data["test/good"] ?? {}).map((r) => r.length)).toEqual([
    1, 1, 1, 1,
  ]);
  expect(results[0].reads).toHaveLength(2);
  expect(results[0].reads[0]?.failure).toBeUndefined();
  expect(results[0].reads[1]?.failure).toContain("offline");
  expect(results[1].reads[0]?.failure).toBeUndefined();
});

test("matches each run to the open PR at its head and reads its files once per head", async () => {
  const older = "c1c308ae709bd66451a299509b69097888ac5f81";
  let fileReads = 0;
  const fixture: Handler = (path) => {
    if (path.includes("/files?")) fileReads++;
    if (path.includes(STACK) && path.includes("/actions/runs"))
      return {
        total: 6,
        runs: [raw(1), raw(2), raw(3, older), raw(4, older), raw(5, "old"), raw(6, "old")],
      };
    if (path.includes("pulls?")) return [pr(), pr(327, older)];
    if (path.includes("/327/files?"))
      return Array.from({ length: 41 }, (_, i) => ({ path: `services/rafs/file-${i}.yaml` }));
    if (path.endsWith("/327")) return { changed: 41, additions: 2271, deletions: 81 };
    return approvals(path);
  };
  const first = await replay((gh) => readApprovals(gh, ctx()), fixture);
  expect(fileReads).toBe(2);
  expect(first.data[STACK]?.map((r) => r.pr?.number ?? r.pr)).toEqual([
    343,
    343,
    327,
    327,
    null,
    null,
  ]);
  const { sha, ...metadata } = pr();
  expect(first.data[STACK]?.[0]?.pr).toStrictEqual({
    ...metadata,
    headSha: sha,
    files: files.map((f) => f.path),
    changedFiles: 2,
    additions: 90,
    deletions: 12,
  });
  const restored: unknown = JSON.parse(JSON.stringify(first.cache));
  const second = await replay(
    (gh) => readApprovals(gh, ctx(), restored),
    (path) => {
      expect(path).not.toMatch(/\/pulls\/\d+/);
      return fixture(path);
    },
  );
  expect(second).toEqual(first);
  expect(first.reads).toHaveLength(ctx().fleet.repos.length);
  expect(first.reads.every((r) => !r.failure && r.completeness.kind === "complete")).toBe(true);
});

test("a new PR head misses the cache without mutating the caller's state", async () => {
  const state = {
    [`${STACK}#343@old`]: { files: ["old"], changedFiles: 1, additions: 1, deletions: 0 },
  };
  const result = await replay((gh) => readApprovals(gh, ctx(), state), approvals);
  expect(Object.keys(result.cache)).toHaveLength(2);
  expect(Object.keys(state)).toHaveLength(1);
});

test("approval runs paginate, and open PRs and files use the forge's full pagination", async () => {
  const result = await replay(
    (gh) => readApprovals(gh, ctx()),
    (path) => {
      if (path.includes(STACK) && path.includes("/actions/runs"))
        return {
          total: 2,
          runs: [path.includes("&page=2") ? raw(2, "old") : raw()],
        };
      if (path.includes("/files?"))
        return Array.from({ length: 101 }, (_, i) => ({ path: `file-${i}` }));
      if (path.endsWith("/343")) return { changed: 101, additions: 102, deletions: 3 };
      return approvals(path);
    },
  );
  expect(result.data[STACK]?.map((r) => r.pr?.number ?? r.pr)).toEqual([343, null]);
  expect(result.data[STACK]?.[0]?.pr?.files).toHaveLength(101);
  expect(result.reads.find((r) => r.source === STACK)?.completeness.kind).toBe("complete");
});

test.each(["actions/runs", "pulls?", "/files?", "/343"])(
  "approval %s failure preserves unread PRs and does not poison other repositories",
  async (failing) => {
    const result = await replay(
      (gh) => readApprovals(gh, ctx()),
      (path) =>
        path.includes(STACK) && path.includes(failing) ? new Error("denied") : approvals(path),
    );
    const failed = result.reads.filter((r) => r.failure);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ source: STACK, failure: expect.stringContaining("denied") });
    expect(result.data[STACK]?.[0]?.pr).toBeUndefined();
    expect(result.cache).toEqual({});
    expect(Object.keys(result.data).filter((r) => r !== STACK)).toHaveLength(1);
  },
);

test.each(["runs", "files"])(
  "a cut %s read is incomplete, not an empty or complete success",
  async (area) => {
    const result = await replay(
      (gh) => readApprovals(gh, ctx()),
      (path) => {
        if (area === "runs" && path.includes(STACK) && path.includes("/actions/runs")) {
          return { total: 2, runs: path.includes("&page=2") ? [] : [raw()] };
        }
        if (area === "files" && path.endsWith("/343"))
          return { changed: 3001, additions: 90, deletions: 12 };
        return approvals(path);
      },
    );
    const read = result.reads.find((r) => r.source === STACK);
    expect(read?.completeness).toMatchObject({
      kind: "cut",
      read: area === "runs" ? 1 : 2,
      total: area === "runs" ? 2 : 3001,
    });
    expect(
      envelopeOf(result.reads, { now: FIXTURE_NOW.getTime(), intervalMs: 300_000 }).state,
    ).toBe("incomplete");
    if (area === "files") {
      expect(result.cache).toEqual({});
      expect(result.data[STACK]?.[0]?.pr).toBeUndefined();
    }
  },
);

test("invalid loaded JSON is discarded with failure evidence before files are read again", async () => {
  const state = JSON.parse(
    `{"${STACK}#343@${raw().head_sha}":{"files":[],"changedFiles":2,"additions":90,"deletions":12}}`,
  );
  const result = await replay((gh) => readApprovals(gh, ctx(), state), approvals);
  expect(result.reads.find((r) => r.source === "persist")).toMatchObject({
    object: "pr-files-cache",
    failure: expect.stringContaining("Invalid PR-files cache"),
  });
  expect(result.data[STACK]?.[0]?.pr?.files).toEqual(files.map((f) => f.path));
});
