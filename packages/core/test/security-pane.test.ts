// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { SecurityPaneSchema } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { alertRows } from "../src/brief/service-upstream";
import { forkPaths } from "../src/model/repos";
import { classify } from "../src/security/classify";
import { type SecuritySource, securityPane } from "../src/security/index";
import { securityCase, sweep1116Source } from "./security-cases";

// upstream-1116.json counted by hand from each alert's own path: a fork's fork_owned trees are SPI,
// any testing or test directory, a development scope, tooling tops and no file are tests, the rest
// is upstream; the two program repositories own every shipped path. [alerts, high or critical].
const BY_HAND: Record<string, Record<"spi" | "upstream" | "tests", [number, number]>> = {
  partition: { spi: [3, 2], upstream: [1, 1], tests: [2, 0] },
  entitlements: { spi: [2, 2], upstream: [10, 0], tests: [3, 0] },
  legal: { spi: [2, 2], upstream: [1, 0], tests: [5, 2] },
  schema: { spi: [5, 3], upstream: [1, 0], tests: [7, 4] },
  file: { spi: [6, 2], upstream: [7, 1], tests: [6, 3] },
  storage: { spi: [3, 3], upstream: [1, 0], tests: [4, 1] },
  indexer: { spi: [2, 2], upstream: [1, 1], tests: [7, 2] },
  search: { spi: [2, 2], upstream: [7, 1], tests: [13, 3] },
  workflow: { spi: [12, 3], upstream: [21, 7], tests: [37, 19] },
  "indexer-queue": { spi: [5, 3], upstream: [1, 1], tests: [4, 2] },
  unit: { spi: [4, 2], upstream: [7, 2], tests: [13, 3] },
  "crs-catalog": { spi: [1, 1], upstream: [15, 14], tests: [44, 20] },
  "crs-conversion": { spi: [5, 3], upstream: [82, 81], tests: [46, 20] },
  "osdu-spi": { spi: [1, 0], upstream: [0, 0], tests: [12, 8] },
  "osdu-spi-stack": { spi: [0, 0], upstream: [0, 0], tests: [0, 0] },
};

const LANES = ["spi", "upstream", "tests"] as const;
const exact = (n: number) => ({ n, atLeast: false });
const atLeast = (n: number) => ({ n, atLeast: true });

function laneCounts(source: SecuritySource) {
  const pane = securityPane(source);
  return {
    pane,
    lanes: pane.lanes.map(({ id, total, high }) => [id, total, high]),
  };
}

describe("securityPane over the 16 Nov sweep", () => {
  const source = sweep1116Source();
  const { pane, lanes } = laneCounts(source);
  const { alerts } = classify(source);

  it("parses as the snapshot's security pane", () => {
    expect(SecurityPaneSchema.parse(pane)).toEqual(pane);
  });

  it("classifies every alert of all 15 repositories by its own path, as counted by hand", () => {
    expect(pane.repositories.map(({ name }) => name)).toEqual(Object.keys(BY_HAND));
    const byRepo = Object.fromEntries(
      Object.keys(BY_HAND).map((name) => [
        name,
        Object.fromEntries(
          LANES.map((lane) => {
            const mine = alerts.filter((a) => a.repository === name && a.lane === lane);
            return [lane, [mine.length, mine.filter((a) => a.high).length]];
          }),
        ),
      ]),
    );
    expect(byRepo).toEqual(BY_HAND);
    expect(lanes).toEqual([
      ["spi", exact(53), exact(30)],
      ["upstream", exact(155), exact(109)],
      ["tests", exact(203), exact(87)],
    ]);
    expect(pane.alerts).toEqual({ total: exact(411), dependabot: exact(211), code: exact(200) });
    expect(pane.read).toBe(true);
    expect(pane.unread).toEqual([]);
  });

  it("puts workflow's two src/main CSRF alerts in SPI code and its src/test one in tests", () => {
    const csrf = alerts
      .filter(
        (a) =>
          a.repository === "workflow" && a.code?.rule === "java/spring-disabled-csrf-protection",
      )
      .filter((a) => a.path?.startsWith("provider/workflow-azure/"))
      .map(({ number, lane, key }) => [number, lane, key]);
    expect(csrf.sort()).toEqual([
      [3, "spi", "spi:code:CodeQL:java/spring-disabled-csrf-protection"],
      [4, "spi", "spi:code:CodeQL:java/spring-disabled-csrf-protection"],
      [5, "tests", "tests:code:CodeQL:java/spring-disabled-csrf-protection"],
    ]);
  });

  it("agrees with each fork's service Security tab, which groups the same alerts", () => {
    for (const line of source.model.lines) {
      const { repo, id } = line.fork;
      const rows = alertRows(
        source.facts.security.data?.[repo] ?? {},
        forkPaths(line.fork, source.facts.radar.data?.filters, source.facts.template.data?.synced),
        source.facts.github.data?.repos[repo]?.pastPrs ?? [],
      );
      const tab = Object.fromEntries(
        LANES.map((lane) => [
          lane,
          rows.filter((row) => row.group === lane).reduce((n, row) => n + row.alerts.length, 0),
        ]),
      );
      const keys = new Set(rows.map((row) => row.id));
      const mine = alerts.filter((a) => a.repository === id);
      expect(tab, id).toEqual(
        Object.fromEntries(LANES.map((lane) => [lane, BY_HAND[id]?.[lane][0]])),
      );
      expect(
        mine.every((a) => keys.has(a.key)),
        id,
      ).toBe(true);
    }
  });

  it("finds Dependabot PRs closed unmerged for the fixture's alerts", () => {
    expect(alerts.filter((a) => a.closedPr).length).toBeGreaterThan(0);
  });
});

describe("a list not read", () => {
  it.each(["partial", "retained", "failed", "clean", "single"] as const)(
    "parses as a pane: %s",
    (name) => {
      const pane = securityPane(securityCase(name));
      expect(SecurityPaneSchema.parse(pane)).toEqual(pane);
    },
  );

  it("contributes no alert when absent, is named with its repository, and leaves every total at least", () => {
    const source = securityCase("partial");
    const pane = securityPane(source);
    const { alerts } = classify(source);
    expect(pane.unread).toEqual([
      expect.objectContaining({ repository: "workflow", list: "code", retained: false }),
      expect.objectContaining({
        repository: "crs-conversion",
        list: "dependabot",
        retained: false,
      }),
    ]);
    expect(alerts.some((a) => a.repository === "workflow" && a.list === "code")).toBe(false);
    expect(alerts.some((a) => a.repository === "crs-conversion" && a.list === "dependabot")).toBe(
      false,
    );
    expect(pane.read).toBe(true);
    expect(pane.lanes.map(({ total, high }) => [total, high])).toEqual([
      [atLeast(38), atLeast(25)],
      [atLeast(137), atLeast(104)],
      [atLeast(152), atLeast(62)],
    ]);
    expect(pane.alerts.total.atLeast).toBe(true);
    expect(pane.alerts.dependabot.atLeast).toBe(true);
    expect(pane.alerts.code.atLeast).toBe(true);
  });

  it("counts a list retained from an earlier read and names its repository alone", () => {
    const source = securityCase("retained");
    const pane = securityPane(source);
    const held = sweep1116Source().facts.security.data?.["Azure/osdu-spi-file"];
    expect(pane.unread).toEqual([
      expect.objectContaining({
        repository: "file",
        retained: true,
        at: "2026-11-17T00:39:13.604Z",
      }),
    ]);
    expect(pane.unread[0]).not.toHaveProperty("list");
    expect(pane.unread[0]?.record?.failure).toBe("HTTP 502: Bad Gateway");
    expect(classify(source).alerts.filter((a) => a.repository === "file")).toHaveLength(
      (held?.dependabot?.length ?? 0) + (held?.code?.length ?? 0),
    );
    expect(pane.lanes.map(({ total }) => total)).toEqual([atLeast(53), atLeast(155), atLeast(203)]);
  });

  it("reads a list read and empty as read and zero", () => {
    const pane = securityPane(securityCase("single"));
    expect(pane.unread).toEqual([]);
    expect(pane.lanes.map(({ total, high }) => [total, high])).toEqual([
      [exact(1), exact(1)],
      [exact(0), exact(0)],
      [exact(0), exact(0)],
    ]);
    expect(pane.alerts).toEqual({ total: exact(1), dependabot: exact(1), code: exact(0) });
  });

  it("reads nothing when every read failed, though the lists retained are still counted", () => {
    const pane = securityPane(securityCase("failed"));
    expect(pane.read).toBe(false);
    expect(pane.unread).toHaveLength(15);
    expect(pane.unread.every((entry) => entry.list === undefined)).toBe(true);
    expect(pane.alerts.total).toEqual(atLeast(411));
    expect(pane.page.headline).toEqual([]);
    expect(
      pane.lanes.every(
        ({ byRule, byRepository, figure }) =>
          byRule.rules.length === 0 && byRepository.rows.length === 0 && figure.blocks.length === 0,
      ),
    ).toBe(true);
  });

  it("holds nothing before the first security read", () => {
    const source = sweep1116Source();
    const { security: _security, ...rest } = source.facts;
    const facts = { ...rest, security: {} };
    const pane = securityPane({ ...source, facts });
    expect(pane.read).toBe(false);
    expect(pane.alerts.total).toEqual(atLeast(0));
    expect(pane.unread.map(({ repository, retained }) => [repository, retained])).toEqual(
      Object.keys(BY_HAND).map((name) => [name, false]),
    );
  });
});

describe("the clean fixture", () => {
  it("holds no SPI alert and leaves the other lanes as they were", () => {
    const { lanes } = laneCounts(securityCase("clean"));
    expect(lanes).toEqual([
      ["spi", exact(0), exact(0)],
      ["upstream", exact(155), exact(109)],
      ["tests", exact(203), exact(87)],
    ]);
  });
});
