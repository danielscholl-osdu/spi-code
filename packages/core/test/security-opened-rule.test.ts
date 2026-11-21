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

  it("says no patched version yet for a manifest none of whose advisories has one", () => {
    const data = structuredClone(source.facts.security.data ?? {});
    for (const alerts of Object.values(data))
      alerts.dependabot = alerts.dependabot?.map((fact) =>
        fact.manifest === "testing/workflow-test-core/pom.xml"
          ? { ...fact, fixed: undefined }
          : fact,
      );
    const unpatched = {
      ...source,
      facts: { ...source.facts, security: { ...source.facts.security, data } },
    };
    const lines = opened(unpatched, DATABIND).where;
    expect(lines.map(({ needs }) => needs[0])).toEqual([
      "first patched in ",
      "no patched version yet for ",
    ]);
    expect(lines[1]?.needs).toEqual(["no patched version yet for ", exact(13)]);
  });

  it("dates Open since by its alerts' whole UTC day and passes over a time it cannot read", () => {
    const since = (times: string[]) => {
      const mine = classify(source).alerts.filter((alert) => alert.key === CSRF);
      const data = structuredClone(source.facts.security.data ?? {});
      for (const alerts of Object.values(data))
        alerts.code = alerts.code?.map((fact) => {
          const at = mine.findIndex((alert) => alert.code?.url === fact.url);
          return at >= 0 ? { ...fact, createdAt: times[at % times.length] ?? "" } : fact;
        });
      const moved = {
        ...source,
        facts: { ...source.facts, security: { ...source.facts.security, data } },
      };
      return opened(moved, CSRF).facts.find(({ label }) => label === "Open since")?.words;
    };
    expect(since(["2025-03-04T10:00:00Z", "2026-03-04T10:00:00Z"])).toEqual([
      "4 Mar 2025",
      ", newest ",
      "4 Mar 2026",
    ]);
    expect(since(["not a time", "2026-03-04T10:00:00Z", "2026-03-05T10:00:00Z"])).toEqual([
      "4 Mar",
      ", newest ",
      "5 Mar",
    ]);
    expect(since(["not a time"])).toBeUndefined();
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
        verbatim: true,
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
      { label: "What it is", words: [HELP], verbatim: true },
      {
        label: "Rule",
        words: [{ code: "java/spring-disabled-csrf-protection" }, " · CodeQL", " · CWE-352"],
        verbatim: true,
      },
    ]);
    expect(SecurityOpenedRuleSchema.parse(rule)).toEqual(rule);
  });

  it("names every distinct CWE on an alert once, without its zero padding", () => {
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

  it("leaves out the help and the CWE each on its own when the scanner gives none, with no empty line", () => {
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

describe("an opened rule's CWE across its alerts", () => {
  it("names the CWEs of every alert, in the order first seen", () => {
    const source = sweep1116Source();
    const mine = classify(source).alerts.filter((alert) => alert.key === CSRF);
    const tagged = new Map([
      [mine[0]?.code?.url, ["external/cwe/cwe-079"]],
      [mine[1]?.code?.url, ["external/cwe/cwe-116", "external/cwe/cwe-079"]],
    ]);
    const data = structuredClone(source.facts.security.data ?? {});
    for (const alerts of Object.values(data))
      alerts.code = alerts.code?.map((fact) => {
        const tags = tagged.get(fact.url);
        return tags ? (parseCodeAlert({ ...fact, tags }) as CodeAlertFact) : fact;
      });
    const both = {
      ...source,
      facts: { ...source.facts, security: { ...source.facts.security, data } },
    };
    expect(opened(both, CSRF).cwe).toBe("CWE-79, CWE-116");
  });
});

describe("what an opened rule says is as the scanner wrote it", () => {
  const source = sweep1116Source();
  const keys = [...new Set(classify(source).alerts.map(({ key }) => key))];
  const rules = keys.map((key) => ({ key, rule: opened(source, key) }));

  it("marks the help verbatim only from the alert it is taken from", () => {
    const mine = classify(source).alerts.filter((alert) => alert.key === CSRF);
    const [first] = mine;
    const help = "Synthetic help, whole.";
    const data = structuredClone(source.facts.security.data ?? {});
    for (const alerts of Object.values(data))
      alerts.code = alerts.code?.map((fact) => {
        if (!mine.some((alert) => alert.code?.url === fact.url)) return fact;
        const parsed = parseCodeAlert({ ...fact, fullDescription: help }) as CodeAlertFact;
        if (fact.url !== first?.code?.url) return parsed;
        const { verbatim: _, ...older } = parsed;
        return older;
      });
    const mixed = {
      ...source,
      facts: { ...source.facts, security: { ...source.facts.security, data } },
    };
    const what = opened(mixed, CSRF).facts.find(({ label }) => label === "What it is");
    expect(what).toEqual({ label: "What it is", words: [help] });
  });

  it("marks an advisory verbatim only when its words carry GitHub's summary untrimmed", () => {
    const summaries = new Map(
      classify(source).alerts.flatMap(({ dependabot }) =>
        dependabot ? [[dependabot.cve ?? dependabot.advisory, dependabot.summary] as const] : [],
      ),
    );
    const advisories = rules.flatMap(({ rule }) =>
      rule.facts.flatMap(({ advisories }) => [
        ...(advisories?.preview ?? []),
        ...(advisories?.rest ?? []),
      ]),
    );
    const changed = advisories.filter(({ verbatim }) => !verbatim);
    expect(changed.length).toBeGreaterThan(0);
    for (const advisory of advisories) {
      const summary = summaries.get(advisory.id) ?? "";
      expect(advisory.verbatim === true, advisory.id).toBe(summary === summary.trim());
      expect(advisory.words.at(-1), advisory.id).toBe(summary.trim());
    }
  });

  it("marks Where files and Most in verbatim only when they name their own alerts' paths whole", () => {
    const all = classify(source).alerts;
    const pathsOf = (key: string, repository?: string) =>
      new Set(
        all.flatMap((alert) =>
          alert.key === key && alert.path && (!repository || alert.repository === repository)
            ? [alert.path]
            : [],
        ),
      );
    const named = (words: SecurityWords) =>
      words.flatMap((part) => (typeof part === "object" && "code" in part ? [part.code] : []));
    const lines = rules.flatMap(({ key, rule }) =>
      rule.where
        .filter(({ read }) => read)
        .map((line) => ({ ...line, paths: pathsOf(key, line.repository) })),
    );
    const most = rules.flatMap(({ key, rule }) =>
      rule.facts
        .filter(({ label }) => label.startsWith("Most in"))
        .map((fact) => ({ ...fact, paths: pathsOf(key) })),
    );
    for (const line of [
      ...lines.map(({ files, verbatim, paths }) => ({ words: files, verbatim, paths })),
      ...most,
    ])
      expect(line.verbatim === true, JSON.stringify(line.words)).toBe(
        named(line.words).every((path) => line.paths.has(path)),
      );
    expect(lines.some(({ verbatim }) => verbatim)).toBe(true);
    expect(lines.some(({ verbatim }) => !verbatim)).toBe(true);
    expect(most.length).toBeGreaterThan(0);
    for (const { rule } of rules)
      for (const fact of rule.facts.filter(({ label }) =>
        ["Rule", "Package", "Open since"].includes(label),
      ))
        expect(fact.verbatim, fact.label).toBe(true);
  });

  const SYNTHETIC = "synthetic/path-alias";
  const DEEP = "lib/a/deep/Synthetic.java";
  const ROOT = "Synthetic.java";
  /** The sweep with each repository's first code alerts moved onto one rule, at the paths given. */
  function placed(paths: Record<string, string[]>) {
    const data = structuredClone(source.facts.security.data ?? {});
    for (const [repo, mine] of Object.entries(paths)) {
      const alerts = data[repo];
      if (!alerts?.code) throw new Error(`${repo} has no code alerts`);
      alerts.code = alerts.code.map((fact, index) => {
        const path = mine[index];
        return path ? { ...fact, tool: "FixtureScanner", rule: SYNTHETIC, path } : fact;
      });
    }
    const moved = {
      ...source,
      facts: { ...source.facts, security: { ...source.facts.security, data } },
    };
    const key = classify(moved).alerts.find(({ code }) => code?.rule === SYNTHETIC)?.key;
    if (!key) throw new Error("No alert carries the synthetic rule");
    const rule = opened(moved, key);
    return {
      where: rule.where.map(({ repository, files, verbatim }) => ({ repository, files, verbatim })),
      most: rule.facts.find(({ label }) => label === "Most in"),
    };
  }

  it("keeps one Most in spot for a path and another path that adds a line to it", () => {
    const { most } = placed({
      "Azure/osdu-spi-file": [ROOT, ROOT, ROOT, `${ROOT}\nextra`, `${ROOT}\nextra`],
    });
    expect(most?.words).toEqual([{ code: ROOT }, " in file, ", exact(3), " alerts"]);
  });

  it("marks a Where line shortened to a basename as changed, though another alert's whole path is that basename", () => {
    const { where, most } = placed({ "Azure/osdu-spi-file": [DEEP, DEEP, DEEP, DEEP, ROOT] });
    expect(where).toEqual([
      { repository: "file", files: [{ code: ROOT }, " ×4", ", ", { code: ROOT }] },
    ]);
    expect(most?.words[0]).toEqual({ code: ROOT });
    expect(most).not.toHaveProperty("verbatim");
  });

  it("marks a Where line verbatim when every basename it shows is its alerts' whole path", () => {
    const { where, most } = placed({
      "Azure/osdu-spi-file": ["Other.java", "Other.java", "Other.java", "Other.java", ROOT],
    });
    expect(where).toEqual([
      {
        repository: "file",
        files: [{ code: "Other.java" }, " ×4", ", ", { code: ROOT }],
        verbatim: true,
      },
    ]);
    expect(most?.words[0]).toEqual({ code: "Other.java" });
    expect(most).toHaveProperty("verbatim", true);
  });

  it("marks Most in changed when one spot is shortened and another spot's whole path is its basename", () => {
    const { where, most } = placed({
      "Azure/osdu-spi-file": [DEEP, DEEP, DEEP, DEEP],
      "Azure/osdu-spi-workflow": [ROOT, ROOT, ROOT],
    });
    expect(where.map(({ verbatim }) => verbatim)).toEqual([true, true]);
    expect(most?.words.filter((part) => typeof part === "object" && "code" in part)).toEqual([
      { code: ROOT },
      { code: ROOT },
    ]);
    expect(most).not.toHaveProperty("verbatim");
    const whole = placed({
      "Azure/osdu-spi-file": [ROOT, ROOT, ROOT, ROOT],
      "Azure/osdu-spi-workflow": [ROOT, ROOT, ROOT],
    });
    expect(whole.most).toHaveProperty("verbatim", true);
  });
});
