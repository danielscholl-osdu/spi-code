// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { DependencyAlertFact, Facts } from "../../src/facts";
import { inspectRepo, type RepoInspection, repoTitle } from "../../src/inspect/repo";
import { buildModel } from "../../src/model/index";
import { fixtureContext } from "../briefing-setup";
import { FIXTURE_NOW, fixtureFacts } from "../harness";

// The rib's test/repositories.test.ts fixture edits at the pinned revision.
const CRITICAL: DependencyAlertFact = {
  number: 900,
  severity: "critical",
  package: "org.asynchttpclient:async-http-client",
  ecosystem: "maven",
  manifest: "provider/partition-azure/pom.xml",
  scope: "runtime",
  advisory: "GHSA-0000-0000-0001",
  summary: "async-http-client leaks credentials on redirect",
  url: "https://github.com/Azure/osdu-spi-partition/security/dependabot/900",
  createdAt: "2026-10-01T00:00:00Z",
};
const variants: Record<string, (f: Facts) => void> = {
  fixture: () => {},
  critical: (f) => {
    f.security.data?.["Azure/osdu-spi-partition"]?.dependabot?.push(CRITICAL);
  },
  "code-hidden": (f) => {
    const a = f.security.data?.["Azure/osdu-spi-legal"];
    if (a) delete a.code;
  },
};

function model(variant = "fixture") {
  const f = fixtureFacts();
  const edit = variants[variant];
  if (!edit) throw new Error(`Unknown variant ${variant}`);
  edit(f);
  return buildModel(f, FIXTURE_NOW, {}, fixtureContext);
}

// The rib draws the same data as a Canvas board; rebuild that shape to compare.
function board(r: RepoInspection) {
  return {
    view: "board",
    title: r.title,
    header: { status: r.status, chip: r.chip },
    sections: [
      { kind: "rows", items: [{ glyph: "info", text: r.summary }] },
      {
        kind: "tabs",
        tabs: r.tabs.map((tab) => ({
          ...tab,
          sections: tab.sections.map((section) => ({ kind: "rows", ...section })),
        })),
      },
      {
        kind: "rows",
        title: "On GitHub",
        items: r.links.map((link) => ({ icon: "↗", ...link })),
      },
    ],
  };
}

interface Oracle {
  revision: string;
  now: string;
  cases: {
    variant: string;
    id: string;
    title?: string;
    board: { header: { status: { label: string } } };
  }[];
}
const oracle: Oracle = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/rib-59d6895/oracle/repo-board.json", import.meta.url),
    "utf8",
  ),
);

describe("repository inspector parity", () => {
  test("the oracle covers every fixture repository and an unwatched id at the fixture time", () => {
    expect(oracle.now).toBe(FIXTURE_NOW.toISOString());
    const ids = oracle.cases.filter((c) => c.variant === "fixture").map((c) => c.id);
    expect(ids).toEqual([
      ...model().repositories.rows.map((r) => `repo:${r.name}`),
      "repo:not-watched",
    ]);
  });

  test.each(oracle.cases.map((c) => [`${c.variant} ${c.id}`, c] as const))(
    "%s matches the frozen rib board",
    (_, c) => {
      const m = model(c.variant);
      const result = inspectRepo(m, c.id, FIXTURE_NOW);
      expect(repoTitle(m, c.id)).toBe(c.title);
      if (c.board.header.status.label === "UNKNOWN") expect(result).toBeUndefined();
      else expect(result && board(result)).toEqual(c.board);
    },
  );
});

describe("the repository inspector", () => {
  test("human-required issues come first in the Issues tab", () => {
    const issues = inspectRepo(model(), "repo:entitlements", FIXTURE_NOW)?.tabs[0];
    expect(issues?.label).toBe("Issues");
    expect(issues?.sections[0]?.items[0]?.chip).toEqual({
      label: "human-required",
      tone: "error",
    });
  });

  test("draws vulnerabilities and code scanning apart from PRs and issues", () => {
    const result = inspectRepo(model("critical"), "repo:partition", FIXTURE_NOW);
    expect(result?.title).toBe("Critical vulnerability in async-http-client");
    expect(result?.tabs.map((t) => t.label)).toEqual([
      "Issues",
      "PRs",
      "Vulnerabilities",
      "Code scanning",
    ]);
  });

  test("a list GitHub hides says so instead of drawing nothing", () => {
    const result = inspectRepo(model("code-hidden"), "repo:legal", FIXTURE_NOW);
    expect(JSON.stringify(result)).toContain("Code-scanning alerts are not readable");
  });
});
