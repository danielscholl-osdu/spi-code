// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { FormingSchema } from "@spi-code/contracts";
import { describe, expect, test } from "vitest";
import { type ReleaseBody, releaseBodyKey } from "../src/collect/releases.js";
import { fleetOf, TEMPLATE_REPO } from "../src/config.js";
import { createContext } from "../src/context.js";
import {
  type FormingInput,
  formingReleases,
  parseBody,
  parseFormingBody,
} from "../src/model/releases.js";

const AT = "2026-11-10T06:00:00.000Z";
const SERVICES = [
  "partition",
  "entitlements",
  "legal",
  "schema",
  "file",
  "storage",
  "indexer",
  "search",
  "workflow",
];
const repoOf = (id: string) => `test/${id}`;
const context = createContext({
  fleet: fleetOf(SERVICES.map((id) => ({ id, repo: repoOf(id), upstream: `upstream/${id}` }))),
  clock: { now: () => new Date(AT) },
});
const sha = (n: number) => String(n).padStart(40, "0");

const BODY = `:robot: I have created a release *beep* *boop*
---


## [1.4.2](https://example.test/compare/v1.4.1...v1.4.2) (2026-11-09)


### ⚠ BREAKING CHANGES

* **api:** drop the synthetic v1 endpoint ([#41](https://example.test/pull/41))

### Features

* add a synthetic batch read ([abc1234](https://example.test/commit/abc1234))
* improve the synthetic cache warm-up

### Bug Fixes

* handle an empty synthetic page
* **deps:** bump fixture-library from 1.0.0 to 1.0.1
* patch CVE-2026-0001 in the synthetic parser

### Miscellaneous Chores

* tidy the synthetic logs
* sync upstream main

---
This PR was generated with [Release Please](https://example.test/release-please).
`;

describe("parseFormingBody", () => {
  test("keeps every entry: untyped entries and dependency bumps count as other", () => {
    expect(parseFormingBody(BODY)).toEqual([
      { kind: "breaking", title: "drop the synthetic v1 endpoint" },
      { kind: "new", title: "add a synthetic batch read" },
      { kind: "improved", title: "improve the synthetic cache warm-up" },
      { kind: "fixed", title: "handle an empty synthetic page" },
      { kind: "other", title: "bump fixture-library from 1.0.0 to 1.0.1" },
      { kind: "security", title: "patch CVE-2026-0001 in the synthetic parser" },
      { kind: "other", title: "tidy the synthetic logs" },
    ]);
  });

  test("an untyped entry that names a vulnerability is security, and a security bump stays security", () => {
    const body =
      "## 1.0.0\n\n### Dependencies\n\n* bump fixture-library to fix CVE-2026-0002\n\n### Other\n\n* rotate the synthetic advisory key\n* rename a synthetic file\n";
    expect(parseFormingBody(body).map((e) => e.kind)).toEqual(["security", "security", "other"]);
  });

  test("the published-release parse still drops untyped entries and types bumps", () => {
    expect(parseBody(BODY).map(({ type, dep }) => [type, dep])).toEqual([
      ["breaking", false],
      ["new", false],
      ["improved", false],
      ["fixed", false],
      ["fixed", true],
      ["security", false],
    ]);
  });
});

function read(repo: string, number: number, body: string, head = sha(number)): ReleaseBody {
  return { state: "read", repo, number, sha: head, at: AT, body };
}
function bodiesOf(...entries: ReleaseBody[]): Record<string, ReleaseBody> {
  return Object.fromEntries(entries.map((b) => [releaseBodyKey(b.repo, b.number, b.sha), b]));
}
function openOf(...prs: [repo: string, number: number, head?: string][]): FormingInput["open"] {
  const open: Record<string, { prs: NonNullable<FormingInput["open"]>[string]["prs"][number][] }> =
    Object.fromEntries(context.fleet.projectRepos.map((r) => [r, { prs: [] }]));
  for (const [repo, number, head = "release-please--branches--main"] of prs) {
    open[repo] ??= { prs: [] };
    open[repo].prs.push({
      number,
      head,
      headSha: sha(number),
      labels: [],
      url: `https://github.com/${repo}/pull/${number}`,
    });
  }
  return open;
}
function forming(input: Omit<FormingInput, "context">) {
  const out = formingReleases({ ...input, context });
  expect(FormingSchema.safeParse(out).success).toBe(true);
  return out;
}

describe("formingReleases", () => {
  test("eight service release PRs and the template's count nine, and the kinds sum to the entries", () => {
    const withPrs = SERVICES.slice(0, 8);
    const bodies = bodiesOf(
      ...withPrs.map((id, i) => read(repoOf(id), 600 + i, BODY)),
      read(TEMPLATE_REPO, 263, "## 1.5.0\n\n### Features\n\n* add a synthetic workflow input\n"),
    );
    const out = forming({
      bodies,
      open: openOf(...withPrs.map((id, i) => [repoOf(id), 600 + i] as [string, number]), [
        TEMPLATE_REPO,
        263,
      ]),
    });
    expect(out.state).toBe("read");
    expect(out.prs).toHaveLength(9);
    expect(out.prs.at(-1)).toMatchObject({ kind: "template", pr: { number: 263 } });
    expect(out.prs[0]).toMatchObject({
      kind: "service",
      service: "partition",
      pr: { number: 600, url: "https://github.com/test/partition/pull/600" },
      state: "read",
    });
    expect(out.kinds).toEqual({
      breaking: 8,
      new: 9,
      improved: 8,
      fixed: 8,
      security: 8,
      other: 16,
    });
    const total = out.prs.reduce((n, p) => n + p.entries.length, 0);
    expect(Object.values(out.kinds ?? {}).reduce((a, b) => a + b, 0)).toBe(total);
    expect(out.text).toBe(
      "Unreleased, in 9 open release PRs: 8 breaking · 9 new · 8 improved · 8 fixed · 8 security · 16 other",
    );
  });

  test("notable entries rank breaking, then security, then new, before fixes, and name the services they reach", () => {
    const bodies = bodiesOf(
      read(repoOf("legal"), 70, "## 1\n\n### Bug Fixes\n\n* fix a synthetic retry\n"),
      read(
        repoOf("search"),
        76,
        "## 1\n\n### Features\n\n* add a synthetic facet\n### Bug Fixes\n\n* apply a security patch to the synthetic client\n",
      ),
      read(
        repoOf("storage"),
        75,
        "## 1\n\n### Bug Fixes\n\n* apply a security patch to the synthetic client\n",
      ),
      read(repoOf("file"), 71, "## 1\n\n### ⚠ BREAKING CHANGES\n\n* drop the synthetic v1 API\n"),
      read(TEMPLATE_REPO, 263, "## 1\n\n### Features\n\n* add a synthetic facet\n"),
    );
    const out = forming({
      bodies,
      open: openOf(
        [repoOf("legal"), 70],
        [repoOf("search"), 76],
        [repoOf("storage"), 75],
        [repoOf("file"), 71],
        [TEMPLATE_REPO, 263],
      ),
    });
    expect(out.notable).toEqual([
      {
        title: "drop the synthetic v1 API",
        kind: "breaking",
        services: ["file"],
        pr: { number: 71, url: "https://github.com/test/file/pull/71" },
        text: "drop the synthetic v1 API on file",
      },
      {
        title: "apply a security patch to the synthetic client",
        kind: "security",
        services: ["storage", "search"],
        pr: { number: 75, url: "https://github.com/test/storage/pull/75" },
        text: "apply a security patch to the synthetic client on storage and search",
      },
      {
        title: "add a synthetic facet",
        kind: "new",
        services: ["search"],
        pr: { number: 76, url: "https://github.com/test/search/pull/76" },
        text: "add a synthetic facet on search and the template",
      },
    ]);
  });

  test("other entries are never notable, and fewer candidates give fewer notable entries", () => {
    const bodies = bodiesOf(
      read(
        repoOf("legal"),
        70,
        "## 1\n\n### Chores\n\n* tidy\n\n### Bug Fixes\n\n* fix a synthetic retry\n",
      ),
    );
    const out = forming({ bodies, open: openOf([repoOf("legal"), 70]) });
    expect(out.notable.map((n) => n.kind)).toEqual(["fixed"]);
  });

  test("a missing body is not read, never zero", () => {
    const out = forming({
      bodies: {},
      open: openOf([repoOf("storage"), 75], [TEMPLATE_REPO, 263]),
    });
    expect(out).toEqual({
      state: "not-read",
      prs: [
        {
          kind: "service",
          service: "storage",
          pr: { number: 75, url: "https://github.com/test/storage/pull/75" },
          state: "not-read",
          entries: [],
        },
        {
          kind: "template",
          pr: { number: 263, url: `https://github.com/${TEMPLATE_REPO}/pull/263` },
          state: "not-read",
          entries: [],
        },
      ],
      notable: [],
      text: "Unreleased, in 2 open release PRs: not read this sweep",
    });
    expect(out).not.toHaveProperty("kinds");
  });

  test("a not-read entry from the releases read is not read; with some read the state is partial", () => {
    const failed: ReleaseBody = {
      state: "not-read",
      repo: repoOf("search"),
      number: 76,
      sha: sha(76),
      at: AT,
      reason: "failed",
      failure: "HTTP 502",
    };
    const out = forming({
      bodies: bodiesOf(read(repoOf("storage"), 75, BODY), failed),
      open: openOf([repoOf("storage"), 75], [repoOf("search"), 76]),
    });
    expect(out.state).toBe("partial");
    expect(out.prs.map((p) => p.state)).toEqual(["read", "not-read"]);
    expect(out.kinds).toEqual({
      breaking: 1,
      new: 1,
      improved: 1,
      fixed: 1,
      security: 1,
      other: 2,
    });
    expect(out.text).toBe(
      "Unreleased, in 2 open release PRs (1 not read this sweep): 1 breaking · 1 new · 1 improved · 1 fixed · 1 security · 2 other",
    );
  });

  test("a body read at an older head is not read until the releases read catches up", () => {
    const old = read(repoOf("storage"), 75, BODY, sha(1));
    const out = forming({ bodies: bodiesOf(old), open: openOf([repoOf("storage"), 75]) });
    expect(out.state).toBe("not-read");
    expect(out.prs).toMatchObject([{ service: "storage", pr: { number: 75 }, state: "not-read" }]);
  });

  test("a PR the GitHub read no longer lists is out, and stack or non-release PRs never count", () => {
    const out = forming({
      bodies: bodiesOf(read(repoOf("storage"), 75, BODY), read("test/stack", 9, BODY)),
      open: {
        ...openOf([repoOf("legal"), 80, "feature/x"]),
        "test/stack": {
          prs: [{ number: 9, head: "release-please--x", headSha: sha(9), labels: [] }],
        },
      },
    });
    expect(out).toMatchObject({ state: "read", prs: [], notable: [] });
    expect(out.kinds).toEqual({
      breaking: 0,
      new: 0,
      improved: 0,
      fixed: 0,
      security: 0,
      other: 0,
    });
    expect(out.text).toBe("No release forming: no release PRs open");
  });

  test("without the GitHub read the kept bodies stand, partial, and with neither nothing is read", () => {
    const out = forming({ bodies: bodiesOf(read(repoOf("storage"), 75, BODY)) });
    expect(out.state).toBe("partial");
    expect(out.prs).toMatchObject([{ service: "storage", pr: { number: 75 }, state: "read" }]);
    expect(out.prs[0]?.pr).not.toHaveProperty("url");
    expect(out.text).toBe(
      "Unreleased, in at least 1 open release PR (release PRs of 10 repositories not listed this sweep): 1 breaking · 1 new · 1 improved · 1 fixed · 1 security · 2 other",
    );
    expect(forming({})).toEqual({
      state: "not-read",
      prs: [],
      notable: [],
      text: "Unreleased changes not read this sweep",
    });
  });

  test("a cold GitHub read that listed no repository is not read, never no release forming", () => {
    for (const open of [{}, { [TEMPLATE_REPO]: { prs: [] } }] as FormingInput["open"][]) {
      const out = forming({ bodies: {}, open });
      expect(out).toEqual({
        state: "not-read",
        prs: [],
        notable: [],
        text: "Unreleased changes not read this sweep",
      });
    }
  });

  test("a repository the GitHub read did not list leaves the rest partial, with the gap named", () => {
    const { [repoOf("storage")]: _, ...listed } = openOf([repoOf("legal"), 80]) ?? {};
    const out = forming({
      bodies: bodiesOf(
        read(repoOf("storage"), 75, BODY),
        read(repoOf("legal"), 80, "### Features\n\n* add a synthetic hold\n"),
      ),
      open: listed,
    });
    expect(out.state).toBe("partial");
    expect(out.prs).toMatchObject([
      { service: "legal", pr: { number: 80 }, state: "read" },
      { service: "storage", pr: { number: 75 }, state: "read" },
    ]);
    expect(out.text).toBe(
      "Unreleased, in at least 2 open release PRs (release PRs of 1 repository not listed this sweep): 1 breaking · 2 new · 1 improved · 1 fixed · 1 security · 2 other",
    );

    const none = forming({ bodies: {}, open: listed });
    expect(none).toMatchObject({
      state: "not-read",
      prs: [{ service: "legal", state: "not-read" }],
    });
    expect(none.text).toBe("Unreleased changes not read this sweep");
    expect(none).not.toHaveProperty("kinds");

    const quiet = forming({ bodies: {}, open: { ...listed, [repoOf("legal")]: { prs: [] } } });
    expect(quiet).toMatchObject({ state: "not-read", prs: [] });
    expect(quiet.text).not.toContain("No release forming");
  });

  test("a read body with no entries is read with zero kinds", () => {
    const out = forming({
      bodies: bodiesOf(read(TEMPLATE_REPO, 263, "")),
      open: openOf([TEMPLATE_REPO, 263]),
    });
    expect(out.state).toBe("read");
    expect(out.text).toBe("Unreleased, in 1 open release PR: no changes listed");
  });
});
