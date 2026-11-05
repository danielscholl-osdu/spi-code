// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  checkable,
  entryAcrossForks,
  FILTER_PATH,
  filterSection,
  readFilterFile,
} from "../../src/collect/filters.js";
import { fleetOf, GITLAB_HOST } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { type ExecLogEntry, ReplayExec } from "../../src/exec/recording.js";
import { encodeProject, Gh, Glab } from "../../src/forge.js";

const NOW = "2026-11-05T08:00:00.000Z";
const FILTER = `# comment
service: legal

top_level:
  .config: keep
  docs: keep   # trailing note
  legal-core-plus: strip

testing:
  legal-test-azure: fork
`;
const halt = {
  fork: "entitlements",
  code: "UNKNOWN_TOP_LEVEL",
  entries: ["schemathesis-tests"],
};
const fork = (id: string) => ({ id, repo: `example/${id}`, upstream: `upstream/${id}` });
const context = (ids: string[]) =>
  createContext({
    fleet: fleetOf(ids.map(fork)),
    clock: { now: () => new Date(NOW) },
  });
const file = (text: string) => ({
  sha: "filter-sha",
  content: `${Buffer.from(text).toString("base64")}\n`,
});

function call(cmd: string, args: string[], data: unknown, failure?: string): ExecLogEntry {
  return {
    cmd,
    args,
    stdin: null,
    stdout: JSON.stringify(data),
    stderr: failure ?? "",
    exit: failure ? 1 : 0,
    ms: 1,
  };
}

function filterCall(id: string, text = FILTER, failure?: string): ExecLogEntry {
  return call("gh", ["api", `repos/${fork(id).repo}/contents/${FILTER_PATH}`], file(text), failure);
}

function treeCall(
  id: string,
  names: string[],
  path = "",
  page = 1,
  failure?: string,
): ExecLogEntry {
  return call(
    "glab",
    [
      "api",
      "--hostname",
      GITLAB_HOST,
      `projects/${encodeProject(fork(id).upstream)}/repository/tree?ref=master${path ? `&path=${path}` : ""}&per_page=100&page=${page}`,
    ],
    names.map((name) => ({ name })),
    failure,
  );
}

const replay = (calls: ExecLogEntry[]) =>
  new ReplayExec(calls.map((c) => JSON.stringify(c)).join("\n"));

describe("filter reads", () => {
  test("a section reads as name to verdict, comments ignored, other sections excluded", () => {
    expect([...filterSection(FILTER, "top_level")]).toEqual([
      [".config", "keep"],
      ["docs", "keep"],
      ["legal-core-plus", "strip"],
    ]);
    expect([...filterSection(FILTER, "testing")]).toEqual([["legal-test-azure", "fork"]]);
  });

  test("each other fork is absent, listed, unlisted or unread, and only GETs are issued", async () => {
    const calls = [
      filterCall("partition"),
      treeCall("partition", ["docs"]),
      filterCall("legal"),
      treeCall("legal", ["docs", "schemathesis-tests"]),
      filterCall("schema", "top_level:\n  schemathesis-tests: strip\n"),
      treeCall("schema", ["docs", "schemathesis-tests"]),
      filterCall("file", "", "404"),
      treeCall("file", ["schemathesis-tests"]),
    ];
    const exec = replay(calls);
    const out = await entryAcrossForks(
      new Gh(exec),
      new Glab(exec),
      halt,
      context(["entitlements", "partition", "legal", "schema", "file"]),
    );
    expect(Object.fromEntries(out.map((e) => [e.fork, e.state]))).toEqual({
      partition: "absent",
      legal: "unlisted",
      schema: "listed",
      file: "unread",
    });
    expect(out.find((e) => e.fork === "schema")).toMatchObject({
      verdict: "strip",
      url: `https://github.com/example/schema/blob/main/${FILTER_PATH}`,
    });
    expect(out[0]?.url).toBe(`https://${GITLAB_HOST}/upstream/partition/-/tree/master`);
    for (const entry of out) {
      expect(entry.reads).toEqual([
        {
          source: fork(entry.fork).repo,
          object: FILTER_PATH,
          observedAt: NOW,
          completeness: { kind: "complete" },
          ...(entry.fork === "file" ? { failure: expect.stringContaining("404") } : {}),
        },
        {
          source: fork(entry.fork).upstream,
          object: "repository/tree?ref=master",
          observedAt: NOW,
          completeness: { kind: "complete" },
        },
      ]);
    }
    exec.assertExhausted();
  });

  test.each(["CONFIG_INVALID", "constructor", "toString"])(
    "a %s halt is not checked across forks",
    async (code) => {
      const exec = replay([]);
      expect(
        await entryAcrossForks(
          new Gh(exec),
          new Glab(exec),
          { ...halt, code, entries: ["line 4"] },
          context(["legal"]),
        ),
      ).toEqual([]);
      exec.assertExhausted();
    },
  );

  test("readFilterFile preserves the SHA and decodes base64 whitespace and UTF-8", async () => {
    const text = `${FILTER}# caf\u00e9\n`;
    const exec = replay([filterCall("legal", text)]);
    expect(await readFilterFile(new Gh(exec), fork("legal").repo)).toEqual({
      sha: "filter-sha",
      text,
    });
    exec.assertExhausted();
  });

  test("checkable accepts only supported halts with entries", () => {
    expect(checkable(undefined)).toBe(false);
    expect(checkable({ ...halt, entries: [] })).toBe(false);
    expect(checkable({ ...halt, code: "CONFIG_INVALID" })).toBe(false);
    expect(checkable(halt)).toBe(true);
    expect(checkable({ ...halt, code: "UNKNOWN_TESTING_ENTRY" })).toBe(true);
    for (const code of ["constructor", "toString", "__proto__"]) {
      expect(checkable({ ...halt, code })).toBe(false);
    }
  });

  test("testing entries use the testing map and tree, reading every page", async () => {
    const exec = replay([
      filterCall("legal"),
      treeCall(
        "legal",
        Array.from({ length: 100 }, (_, i) => `entry-${i}`),
        "testing",
      ),
      treeCall("legal", ["legal-test-azure"], "testing", 2),
    ]);
    const out = await entryAcrossForks(
      new Gh(exec),
      new Glab(exec),
      { ...halt, code: "UNKNOWN_TESTING_ENTRY", entries: ["legal-test-azure", "missing"] },
      context(["legal"]),
    );
    expect(out.map(({ state }) => state)).toEqual(["listed", "absent"]);
    expect(out[0]).toMatchObject({ verdict: "fork" });
    expect(out[0]?.reads[1]).toMatchObject({
      object: "repository/tree?ref=master&path=testing",
      completeness: { kind: "complete" },
    });
    expect(out[1]?.url).toBe(`https://${GITLAB_HOST}/upstream/legal/-/tree/master/testing`);
    exec.assertExhausted();
  });

  test("a failed later tree page is unread, never a false absent result", async () => {
    const exec = replay([
      filterCall("legal"),
      treeCall(
        "legal",
        Array.from({ length: 100 }, (_, i) => `entry-${i}`),
      ),
      treeCall("legal", [], "", 2, "503 unavailable"),
    ]);
    const out = await entryAcrossForks(new Gh(exec), new Glab(exec), halt, context(["legal"]));
    expect(out[0]).toMatchObject({
      state: "unread",
      reads: [
        { source: "example/legal", observedAt: NOW },
        {
          source: "upstream/legal",
          observedAt: NOW,
          failure: expect.stringContaining("503 unavailable"),
        },
      ],
    });
    expect(out[0]).not.toHaveProperty("url");
    exec.assertExhausted();
  });

  test("interleaved fleets use only their own forks and clocks", async () => {
    const a = replay([filterCall("legal"), treeCall("legal", ["schemathesis-tests"])]);
    const b = replay([filterCall("other"), treeCall("other", ["schemathesis-tests"])]);
    const later = "2026-11-05T09:00:00.000Z";
    const [left, right] = await Promise.all([
      entryAcrossForks(new Gh(a), new Glab(a), halt, context(["entitlements", "legal"])),
      entryAcrossForks(new Gh(b), new Glab(b), halt, {
        ...context(["other"]),
        clock: { now: () => new Date(later) },
      }),
    ]);
    expect(left.map((e) => e.fork)).toEqual(["legal"]);
    expect(right.map((e) => e.fork)).toEqual(["other"]);
    expect(left[0]?.reads.every((r) => r.observedAt === NOW)).toBe(true);
    expect(right[0]?.reads.every((r) => r.observedAt === later)).toBe(true);
    a.assertExhausted();
    b.assertExhausted();
  });
});
