// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type SecurityOpenedRule,
  SecurityOpenedRuleSchema,
  type SecurityWords,
} from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { parseCodeAlert } from "../src/collect/security";
import type { CodeAlertFact } from "../src/facts";
import type { SecurityRuleHead } from "../src/security/by-rule";
import { classify } from "../src/security/classify";
import type { SecuritySource } from "../src/security/index";
import { securityOpenedRule } from "../src/security/opened-rule";
import { type SecurityCase, securityCase, sweep1116Source } from "./security-cases";

const CSRF = "spi:code:CodeQL:java/spring-disabled-csrf-protection";
const DATABIND = "tests:dep:com.fasterxml.jackson.core:jackson-databind";
const BRANCH_PROTECTION = "tests:code:Scorecard:BranchProtectionID";
const exact = (n: number) => ({ n, atLeast: false });
const atLeast = (n: number) => ({ n, atLeast: true });

function opened(source: SecuritySource, key: string): SecurityOpenedRule {
  const input = { ...classify(source), totals: {} as never };
  return securityOpenedRule(input, { key } as SecurityRuleHead);
}

const counts = (words: SecurityWords) =>
  words.filter((part) => typeof part === "object" && "n" in part);
function everyCount(rule: SecurityOpenedRule) {
  return [
    ...rule.facts.flatMap(({ words, advisories }) => [
      ...counts(words),
      ...[...(advisories?.preview ?? []), ...(advisories?.rest ?? [])].flatMap((a) =>
        counts([...a.words, ...a.fix]),
      ),
    ]),
    ...rule.where.flatMap((line) => counts([...line.count, ...line.files, ...line.needs])),
    ...rule.also.flatMap(({ words }) => counts(words)),
  ];
}

describe("an opened rule over the 16 Nov sweep", () => {
  const source = sweep1116Source();
  const { alerts } = classify(source);

  it("parses for every rule and package in the sweep and in each case", () => {
    const sources: SecuritySource[] = [
      source,
      ...(["partial", "retained", "failed", "clean", "single"] as SecurityCase[]).map(securityCase),
    ];
    for (const each of sources) {
      const keys = new Set(classify(each).alerts.map(({ key }) => key));
      for (const key of keys) {
        const rule = opened(each, key);
        expect(SecurityOpenedRuleSchema.parse(rule), key).toEqual(rule);
      }
    }
  });

  it("lists Disabled Spring CSRF protection in 12 forks with a pill to each of its 22 alerts", () => {
    const rule = opened(source, CSRF);
    const firsts = rule.where.filter(({ first }) => first);
    expect(firsts).toHaveLength(12);
    expect(rule.where.every(({ read }) => read)).toBe(true);
    const mine = alerts.filter(({ key }) => key === CSRF);
    const pills = rule.where.flatMap((line) => line.alerts.map((pill) => [line.repository, pill]));
    expect(pills).toHaveLength(22);
    expect(new Set(pills.map(([, pill]) => (pill as { url: string }).url))).toEqual(
      new Set(mine.map(({ url }) => url)),
    );
    for (const [repository, pill] of pills)
      expect((pill as { name: string }).name.startsWith(`${repository}: CodeQL #`)).toBe(true);
    expect(everyCount(rule).every(({ atLeast }) => !atLeast)).toBe(true);
    expect(rule.also).toEqual([
      {
        key: "tests:code:CodeQL:java/spring-disabled-csrf-protection",
        words: ["Also: ", exact(6), " in tests, tooling and settings"],
      },
    ]);
    expect(rule.ask).toBeUndefined();
  });

  it("orders repositories by count then name, and pills by file then number", () => {
    const rule = opened(source, CSRF);
    expect(rule.where.map(({ repository }) => repository)).toEqual([
      "schema",
      "entitlements",
      "file",
      "indexer",
      "legal",
      "partition",
      "search",
      "storage",
      "workflow",
      "crs-catalog",
      "crs-conversion",
      "indexer-queue",
    ]);
    const storage = rule.where.find(({ repository }) => repository === "storage");
    expect(storage?.alerts.map(({ label }) => label)).toEqual([
      "CodeQL #3 · AADSecurityConfig.java",
      "CodeQL #2 · AzureIstioSecurityConfig.java",
    ]);
    const single = rule.where.find(({ repository }) => repository === "crs-catalog");
    expect(single?.alerts.map(({ label }) => label)).toEqual(["CodeQL #2"]);
  });

  it("gives each of jackson-databind's advisories its own first patched version, and none to the package", () => {
    const rule = opened(source, DATABIND);
    const fact = rule.facts.find(({ advisories }) => advisories);
    const advisories = [...(fact?.advisories?.preview ?? []), ...(fact?.advisories?.rest ?? [])];
    const mine = alerts.filter(({ key }) => key === DATABIND);
    const fixedOf = new Map(
      mine.map(({ dependabot }) => [dependabot?.cve ?? dependabot?.advisory, dependabot?.fixed]),
    );
    expect(advisories).toHaveLength(13);
    expect(fact?.advisories?.preview).toHaveLength(4);
    expect(fact?.advisories?.disclosure?.more).toEqual([exact(9), " more advisories"]);
    for (const advisory of advisories)
      expect(advisory.fix.filter((part) => typeof part === "object" && "code" in part)).toEqual([
        { code: fixedOf.get(advisory.id) },
      ]);
    const versions = new Set(mine.map(({ dependabot }) => dependabot?.fixed));
    const named = rule.facts.flatMap(({ words }) =>
      words.filter((part) => typeof part === "object" && "code" in part && versions.has(part.code)),
    );
    expect(named).toEqual([]);
  });

  it("puts each manifest on its own line with what patches it, its open and closed fix PRs", () => {
    const rule = opened(source, DATABIND);
    expect(
      rule.where.map(({ first, files, prs, more, alerts }) => [
        first,
        files,
        prs.map(({ label }) => label),
        more,
        alerts.length,
      ]),
    ).toEqual([
      [
        true,
        [{ code: "testing/workflow-test-azure/pom.xml" }],
        ["PR #53 behind"],
        "11 Dependabot alerts",
        11,
      ],
      [
        false,
        [{ code: "testing/workflow-test-core/pom.xml" }],
        ["PR #65 closed"],
        "13 Dependabot alerts",
        13,
      ],
    ]);
    expect(rule.where[0]?.count).toEqual([exact(24), ", ", exact(10), " high"]);
    expect(rule.where.every(({ needs }) => needs[0] === "first patched in ")).toBe(true);
    expect(rule.where[1]?.needs).toContainEqual({ code: "2.13.4.2" });
    expect(rule.where[0]?.needs).not.toContainEqual({ code: "2.13.4.2" });
  });

  it("reads a rule with no file as a repository setting, with no file line", () => {
    const rule = opened(source, BRANCH_PROTECTION);
    expect(rule.where).toEqual([
      expect.objectContaining({
        repository: "osdu-spi",
        first: true,
        read: true,
        files: ["Repository setting"],
        alerts: [expect.objectContaining({ label: "Scorecard #7" })],
      }),
    ]);
    expect(rule.where[0]?.alerts[0]?.name).toBe("osdu-spi: Scorecard #7, high, repository setting");
  });

  it("offers Ask only on a rule in one fork that no unread list could spread", () => {
    expect(opened(securityCase("single"), "spi:dep:com.example:widget").ask).toEqual({
      fork: "partition",
    });
    expect(opened(source, DATABIND).ask).toEqual({ fork: "workflow" });
    expect(opened(source, CSRF).ask).toBeUndefined();
    expect(opened(source, BRANCH_PROTECTION).ask).toBeUndefined();
    expect(opened(securityCase("partial"), DATABIND).ask).toBeUndefined();
  });
});

describe("an opened rule while a list was not read", () => {
  it("gives the unread repository a not-read line and keeps the counts of lists read exact", () => {
    const rule = opened(securityCase("partial"), CSRF);
    const workflow = rule.where.filter(({ repository }) => repository === "workflow");
    expect(workflow).toEqual([
      {
        repository: "workflow",
        first: true,
        read: false,
        count: [],
        files: ["Code scanning alerts not read"],
        needs: [],
        alerts: [],
        prs: [],
      },
    ]);
    expect(rule.where.at(-1)?.repository).toBe("workflow");
    expect(rule.where.filter(({ first, read }) => first && read)).toHaveLength(11);
    expect(rule.where.flatMap(({ count }) => counts(count)).every((n) => !n.atLeast)).toBe(true);
    expect(rule.also[0]?.words).toEqual(["Also: ", atLeast(2), " in tests, tooling and settings"]);
    expect(rule.facts.find(({ label }) => label === "Open since")?.words.at(-1)).toBe(
      " in the lists read",
    );
  });

  it("names a Dependabot list not read only on packages", () => {
    const source = securityCase("partial");
    const unread = (key: string) =>
      opened(source, key)
        .where.filter(({ read }) => !read)
        .map(({ repository }) => repository);
    expect(unread("tests:dep:urllib3")).toEqual(["crs-conversion"]);
    expect(unread(CSRF)).toEqual(["workflow"]);
  });

  it("counts a retained list's alerts at least and says they are from the last read", () => {
    const rule = opened(securityCase("retained"), CSRF);
    const file = rule.where.filter(({ repository }) => repository === "file");
    expect(file.map(({ first, read, count }) => [first, read, count])).toEqual([
      [true, true, [atLeast(2)]],
      [false, false, []],
    ]);
    expect(file[1]?.files[0]).toMatch(/not read this sweep/);
    const others = rule.where.filter(({ repository }) => repository !== "file");
    expect(others.flatMap(({ count }) => counts(count)).every((n) => !n.atLeast)).toBe(true);
  });

  it("counts a retained list's remaining files and directories at least", () => {
    const source = securityCase("retained");
    const keys = new Set(classify(source).alerts.map(({ key }) => key));
    const files = [...keys].flatMap((key) =>
      opened(source, key)
        .where.filter(({ repository }) => repository === "file")
        .flatMap((line) => counts(line.files)),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(files.every(({ atLeast }) => atLeast)).toBe(true);
    const sweep = sweep1116Source();
    const read = [...new Set(classify(sweep).alerts.map(({ key }) => key))].flatMap((key) =>
      opened(sweep, key).where.flatMap((line) => counts(line.files)),
    );
    expect(read.length).toBeGreaterThan(0);
    expect(read.every(({ atLeast }) => !atLeast)).toBe(true);
  });
});

describe("an opened rule's help and CWE", () => {
  /** The 16 Nov sweep with the scanner fields given to the last alert of a rule, as parseCodeAlert reads them. */
  function withScanner(
    key: string,
    raw: Record<string, unknown>,
    scope: "last" | "every" = "last",
  ): SecuritySource {
    const source = sweep1116Source();
    const mine = classify(source).alerts.filter((alert) => alert.key === key);
    const marked = scope === "last" ? mine.slice(-1) : mine;
    const data = structuredClone(source.facts.security.data ?? {});
    for (const alerts of Object.values(data))
      alerts.code = alerts.code?.map((fact) =>
        marked.some((alert) => alert.code?.url === fact.url)
          ? (parseCodeAlert({ ...fact, ...raw }) as CodeAlertFact)
          : fact,
      );
    return { ...source, facts: { ...source.facts, security: { ...source.facts.security, data } } };
  }
  const HELP =
    "Disabling CSRF protection makes the application vulnerable to a cross-site request forgery attack.";

  it("reads CWE-352 from the tags and puts the help above the rule, from the one alert that carries them", () => {
    const rule = opened(
      withScanner(CSRF, { fullDescription: HELP, tags: ["security", "external/cwe/cwe-352"] }),
      CSRF,
    );
    expect(rule.help).toBe(HELP);
    expect(rule.cwe).toBe("CWE-352");
    expect(rule.facts.slice(0, 2)).toEqual([
      { label: "What it is", words: [HELP] },
      {
        label: "Rule",
        words: [{ code: "java/spring-disabled-csrf-protection" }, " · CodeQL", " · CWE-352"],
      },
    ]);
    expect(SecurityOpenedRuleSchema.parse(rule)).toEqual(rule);
  });

  it("names every CWE a rule carries once, without its zero padding", () => {
    const tags = [
      "external/cwe/cwe-079",
      "security",
      "external/cwe/cwe-116",
      "external/cwe/cwe-079",
      "external/cwe/cwe-352x",
      "cwe-200",
    ];
    expect(opened(withScanner(CSRF, { tags }), CSRF).cwe).toBe("CWE-79, CWE-116");
  });

  it("gives neither field, and no empty line, to a rule with no tags or no full description", () => {
    const plain = opened(sweep1116Source(), CSRF);
    expect("help" in plain || "cwe" in plain).toBe(false);
    expect(plain.facts.map(({ label }) => label)).not.toContain("What it is");
    expect(plain.facts.find(({ label }) => label === "Rule")?.words).toEqual([
      { code: "java/spring-disabled-csrf-protection" },
      " · CodeQL",
    ]);
    const helpOnly = opened(withScanner(CSRF, { fullDescription: HELP }, "every"), CSRF);
    expect(helpOnly.help).toBe(HELP);
    expect("cwe" in helpOnly).toBe(false);
    expect(helpOnly.facts.find(({ label }) => label === "Rule")?.words).toHaveLength(2);
    const tagsOnly = opened(
      withScanner(CSRF, { tags: ["security", "external/cwe/cwe-352"] }, "every"),
      CSRF,
    );
    expect("help" in tagsOnly).toBe(false);
    expect(tagsOnly.facts.map(({ label }) => label)).not.toContain("What it is");
    const noCwe = opened(
      withScanner(CSRF, { fullDescription: " ", tags: ["security", "correctness"] }, "every"),
      CSRF,
    );
    expect("help" in noCwe || "cwe" in noCwe).toBe(false);
    for (const rule of [plain, helpOnly, tagsOnly, noCwe])
      for (const fact of rule.facts)
        expect(fact.words.length > 0 || fact.advisories !== undefined, fact.label).toBe(true);
  });
});
