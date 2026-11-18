// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ServiceUpstreamSecuritySchema } from "@spi-code/contracts";
import { expect, test } from "vitest";
import { closedFix, openUpstream, serviceUpstream } from "../src/brief/service-upstream";
import type { CodeAlertFact, DependencyAlertFact, Facts, MrFact, PastPrFact } from "../src/facts";
import type { SweepReads } from "../src/sweep/index";
import { SWEEP_1116_NOW as now, sweep1116Facts, sweep1116Model } from "./sweep-1116";

const service = "search";
const repo = `Azure/osdu-spi-${service}`;
const upstream = "osdu/platform/system/search-service";
const MR_LIST = "merge_requests?state=opened&target_branch=master";
const day = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(now.getTime() - days * day).toISOString();

function project(facts: Facts, reads: SweepReads = {}) {
  const result = serviceUpstream({ model: sweep1116Model(facts), facts, reads, now }).get(service);
  if (!result) throw new Error("No lists for search");
  return ServiceUpstreamSecuritySchema.parse(result);
}

function mr(iid: number, updatedDaysAgo: number, draft = false): MrFact {
  return {
    iid,
    title: `MR ${iid}`,
    author: "someone",
    draft,
    labels: [],
    createdAt: ago(60),
    updatedAt: ago(updatedDaysAgo),
    headSha: `sha${iid}`,
    url: `https://community.opengroup.org/${upstream}/-/merge_requests/${iid}`,
  };
}

function dep(
  number: number,
  pkg: string,
  manifest: string,
  overrides: Partial<DependencyAlertFact> = {},
): DependencyAlertFact {
  return {
    number,
    severity: "high",
    package: pkg,
    ecosystem: "maven",
    manifest,
    fixed: "2.0.0",
    advisory: `GHSA-${number}`,
    summary: `Advisory ${number}`,
    url: `https://github.com/${repo}/security/dependabot/${number}`,
    createdAt: ago(10),
    ...overrides,
  };
}

function code(
  number: number,
  rule: string,
  path: string,
  overrides: Partial<CodeAlertFact> = {},
): CodeAlertFact {
  return {
    number,
    severity: "high",
    rule,
    description: `Rule ${rule}`,
    tool: "CodeQL",
    path,
    url: `https://github.com/${repo}/security/code-scanning/${number}`,
    createdAt: ago(10),
    ...overrides,
  };
}

function closed(number: number, head: string): PastPrFact {
  return {
    number,
    title: `Bump ${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    head,
    base: "main",
    createdAt: ago(9),
    closedAt: ago(8),
  };
}

function withAlerts(
  dependabot: DependencyAlertFact[],
  codeAlerts: CodeAlertFact[],
  pastPrs: PastPrFact[] = [],
) {
  const facts = sweep1116Facts();
  const security = facts.security.data;
  const github = facts.github.data?.repos[repo];
  if (!security || !github) throw new Error("Search facts missing");
  security[repo] = { dependabot, code: codeAlerts };
  github.pastPrs = pastPrs;
  return facts;
}

test("the shipped groups' alerts sum to the Security count, and alerts in tests never count", () => {
  const facts = withAlerts(
    [
      dep(1, "com.google.guava:guava", "provider/search-azure/pom.xml"),
      dep(2, "com.google.guava:guava", "provider/search-azure/pom.xml", { severity: "medium" }),
      dep(3, "org.apache.commons:commons-lang3", "pom.xml"),
      dep(4, "org.apache.commons:commons-lang3", "testing/pom.xml"),
      dep(5, "io.netty:netty-all", "search-core/pom.xml", { scope: "development" }),
    ],
    [
      code(10, "java/csrf", "provider/search-azure/src/main/java/AADSecurityConfig.java"),
      code(11, "java/csrf", "provider/search-azure/src/main/java/IstioConfig.java"),
      code(12, "java/log-injection", "search-core/src/main/java/Replay.java", {
        severity: "medium",
      }),
      code(13, "java/csrf", "search-core/src/test/java/SecurityConfiguration.java"),
    ],
  );
  const { security } = project(facts);
  const sum = (group: "spi" | "upstream" | "tests") =>
    security.rows.filter((row) => row.group === group).reduce((n, row) => n + row.alerts.length, 0);
  expect([sum("spi"), sum("upstream"), sum("tests")]).toEqual([4, 2, 3]);
  expect(security.count).toBe(sum("spi") + sum("upstream"));
  expect(security.rows.map((row) => row.group)).toEqual([
    "spi",
    "spi",
    "upstream",
    "upstream",
    "tests",
    "tests",
    "tests",
  ]);

  const guava = security.rows.find((row) => row.title === "com.google.guava:guava");
  expect(guava?.alerts.map(({ number, severity }) => [number, severity])).toEqual([
    [2, "medium"],
    [1, "high"],
  ]);
  expect(guava?.severity).toBe("high");
  const csrf = security.rows.find((row) => row.group === "spi" && row.source === "code");
  expect(csrf?.alerts.map(({ number }) => number)).toEqual([11, 10]);
});

test("a closed Dependabot PR sits on an alert only when its branch names the package and manifest directory", () => {
  const alert = {
    package: "org.apache.commons:commons-lang3",
    manifest: "testing/storage-test-core/pom.xml",
  };
  const match = closed(
    54,
    "dependabot/maven/testing/storage-test-core/org.apache.commons-commons-lang3-3.18.0",
  );
  const elsewhere = closed(55, "dependabot/maven/testing/org.apache.commons-commons-lang3-3.18.0");
  const root = closed(56, "dependabot/maven/org.apache.commons-commons-lang3-3.18.0");
  const longer = closed(
    57,
    "dependabot/maven/testing/storage-test-core/org.apache.commons-commons-lang3-extra-1.0",
  );
  const deeper = closed(59, "dependabot/maven/extra/testing/storage-test-core/org.apache.commons-commons-lang3-3.18.0");
  const merged = { ...match, number: 58, mergedAt: ago(8) };
  expect(closedFix(alert, [match, elsewhere, root, longer, deeper, merged])?.number).toBe(54);
  expect(closedFix(alert, [elsewhere, root, longer, deeper, merged])).toBeUndefined();
  expect(closedFix({ ...alert, manifest: "pom.xml" }, [match, elsewhere, root])?.number).toBe(56);

  const facts = withAlerts(
    [dep(22, alert.package, alert.manifest), dep(23, alert.package, "testing/other/pom.xml")],
    [],
    [match],
  );
  const row = project(facts).security.rows.find((r) => r.title === alert.package);
  expect(row?.alerts.map(({ number, closedPr }) => [number, closedPr?.number])).toEqual([
    [23, undefined],
    [22, 54],
  ]);
});

test("open upstream shows moving non-drafts newest first and counts a draft that is also idle once, as a draft", () => {
  const list = openUpstream(
    [mr(1, 2), mr(2, 45), mr(3, 40, true), mr(4, 1, true), mr(5, 29), mr(6, 0.5)],
    now,
  );
  expect(list.shown.map(({ iid }) => iid)).toEqual([6, 1, 5]);
  expect(list).toMatchObject({ total: 6, drafts: 2, idle: 1 });
  expect(list.shown.length + list.drafts + list.idle).toBe(list.total);
});

function withMrs(mrs: MrFact[] | undefined) {
  const facts = sweep1116Facts();
  const services = facts.radar.data?.services;
  if (!services?.[service]) throw new Error("Search radar missing");
  if (mrs) services[service].mrs = mrs;
  else delete services[service];
  return facts;
}

const failedList = (retainedFrom?: string): SweepReads => ({
  radar: [
    {
      source: upstream,
      object: MR_LIST,
      observedAt: now.toISOString(),
      completeness: { kind: "complete" },
      failure: "GitLab unavailable",
      ...(retainedFrom ? { retainedFrom } : {}),
    },
  ],
});

test("a failed MR read with an earlier good read shows the stale rows with their read time, not read", () => {
  const earlier = ago(1);
  const { open } = project(withMrs([mr(1, 2), mr(2, 3, true)]), failedList(earlier)).upstream;
  expect(open).toMatchObject({ read: false, at: earlier, list: { total: 2, drafts: 1 } });
  expect(open.list?.shown.map(({ iid }) => iid)).toEqual([1]);

  const area = withMrs([mr(1, 2)]);
  area.radar = { ...area.radar, error: "GitLab unavailable", errorAt: now.toISOString() };
  expect(project(area).upstream.open).toMatchObject({
    read: false,
    at: area.radar.at,
    list: { total: 1 },
  });
});

test("a failed MR read with no good read gives no rows, not read", () => {
  const { open } = project(withMrs(undefined), failedList()).upstream;
  expect(open).toEqual({ read: false });
});

test("a good read with no open MRs is an empty list, read", () => {
  const facts = withMrs([]);
  const { open } = project(facts).upstream;
  expect(open).toEqual({
    read: true,
    at: facts.radar.at,
    list: { total: 0, shown: [], drafts: 0, idle: 0 },
  });
});

test("a list hidden from the token or a failed alert read leaves the Security count not read", () => {
  const facts = withAlerts([dep(1, "guava", "pom.xml")], []);
  const security = facts.security.data;
  if (!security) throw new Error("Security facts missing");
  security[repo] = { dependabot: [dep(1, "guava", "pom.xml")] };
  const hidden = project(facts).security;
  expect(hidden).toMatchObject({ count: null, code: { read: false }, dependabot: { read: true } });
  expect(hidden.code.at).toBeUndefined();

  const retained = ago(2);
  const failed = project(withAlerts([dep(1, "guava", "pom.xml")], []), {
    security: [
      {
        source: repo,
        object: "security",
        observedAt: now.toISOString(),
        completeness: { kind: "complete" },
        failure: "HTTP 502",
        retainedFrom: retained,
      },
    ],
  }).security;
  expect(failed).toMatchObject({ count: null, dependabot: { read: false, at: retained } });
  expect(failed.rows).toHaveLength(1);
});
