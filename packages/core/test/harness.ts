// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { emptyFacts, type Facts, type TemplateChange } from "../src/facts";
import fixture from "./fixtures/rib-59d6895/facts.json";

export const FIXTURE_NOW = new Date("2026-10-12T21:58:30Z");

export function fixtureFacts(): Facts {
  return { ...emptyFacts(), ...(structuredClone(fixture) as unknown as Partial<Facts>) };
}

export const NEW_HEAD = "c0de000000000000000000000000000000000130";

function change(n: number, title: string): TemplateChange {
  const sha = `c0de${String(n).padStart(36, "0")}`;
  return {
    sha,
    parent: undefined,
    title,
    pr: 250 + n,
    url: `https://github.com/Azure/osdu-spi/pull/${250 + n}`,
    at: `2026-10-12T1${n}:00:00Z`,
  };
}

export function releasedFacts(): Facts {
  const f = fixtureFacts();
  const repos = f.github.data?.repos;
  const repo = repos?.["Azure/osdu-spi"];
  const t = f.template.data;
  if (!repos || !repo || !t) throw new Error("template facts");
  const fresh = [
    change(4, "chore(release): release 1.3.0"),
    change(3, "feat(java): resolve the Java release from the root pom (#255)"),
    change(2, "build(deps): bump actions/setup-java from 4 to 5 (#254)"),
    change(1, "fix(maven): pin the Maven version (#247)"),
  ];
  repo.head = { sha: NEW_HEAD, at: "2026-10-12T20:55:00Z" };
  repo.release = {
    tag: "v1.3.0",
    at: "2026-10-12T21:00:00Z",
    url: "https://github.com/Azure/osdu-spi/releases/tag/v1.3.0",
  };
  repo.releases = [
    { tag: "v1.3.0", at: "2026-10-12T21:00:00Z", url: repo.release.url },
    { tag: "v1.2.0", at: "2026-10-05T22:43:47Z", url: "" },
  ];
  repo.pastPrs = [
    {
      number: 248,
      title: "chore: release 1.3.0",
      url: "",
      head: "release-please--branches--main",
      base: "main",
      createdAt: "2026-10-06T00:00:00Z",
      mergedAt: "2026-10-12T20:55:00Z",
    },
    {
      number: 255,
      title: "feat(java): resolve the Java release",
      url: "",
      head: "feat/java",
      base: "main",
      createdAt: "2026-10-12T00:00:00Z",
      mergedAt: "2026-10-12T13:00:00Z",
    },
    {
      number: 254,
      title: "build(deps): bump setup-java",
      url: "",
      head: "dependabot/github_actions/setup-java-5",
      base: "main",
      createdAt: "2026-10-11T00:00:00Z",
      mergedAt: "2026-10-12T12:00:00Z",
      author: "dependabot",
    },
    {
      number: 240,
      title: "older",
      url: "",
      head: "feat/old",
      base: "main",
      createdAt: "2026-10-01T00:00:00Z",
      mergedAt: "2026-10-02T00:00:00Z",
    },
  ];
  repo.prs = [];
  t.latestTag = "v1.3.0";
  t.mainAhead = 0;
  for (const c of Object.values(t.compares)) {
    c.head = NEW_HEAD;
    c.aheadBy += fresh.length;
    c.shas = [...fresh.map((x) => x.sha), ...c.shas];
    c.changes = [...fresh, ...c.changes];
  }
  for (const fork of Object.values(repos)) {
    if (fork.repo.startsWith("Azure/osdu-spi-") && fork.repo !== "Azure/osdu-spi-stack")
      fork.syncCrons = ["0 8 * * *"];
  }
  return f;
}

export function laneFacts(down = false): Facts {
  const f = fixtureFacts();
  const lc = f.lifecycle.data;
  if (!lc) throw new Error("fixture has lifecycle runs");
  const cut = Date.parse("2026-10-11T22:00:00Z");
  const refresh = lc.refresh.filter((r) => Date.parse(r.createdAt) < cut);
  const last = refresh[0];
  if (!last) throw new Error("fixture has a refresh before the cut");
  const failed = {
    ...last,
    id: 99000001,
    createdAt: "2026-10-12T21:30:00Z",
    updatedAt: "2026-10-12T21:40:00Z",
    conclusion: "failure",
    jobs: undefined,
  };
  f.lifecycle.data = {
    ...lc,
    refresh: down ? [failed, ...refresh] : refresh,
    upgrade: lc.upgrade.filter((r) => Date.parse(r.createdAt) < cut),
  };
  return f;
}
