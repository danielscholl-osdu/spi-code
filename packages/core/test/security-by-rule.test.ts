// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityLane, SecurityWords } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { type SecurityRuleHead, securityByRule } from "../src/security/by-rule";
import { classify, type SecurityInput } from "../src/security/classify";
import { type SecuritySource, securityPane } from "../src/security/index";
import { securityCase, sweep1116Source } from "./security-cases";

const text = (words: SecurityWords) =>
  words
    .map((part) =>
      typeof part === "string"
        ? part
        : "code" in part
          ? part.code
          : `${part.atLeast ? "≥" : ""}${part.n}`,
    )
    .join("");

const lane = (source: SecuritySource, id: SecurityLane["id"]) => {
  const found = securityPane(source).lanes.find((l) => l.id === id);
  if (!found) throw new Error(`No lane ${id}`);
  return found.byRule;
};
const rule = (rules: readonly SecurityRuleHead[], title: string) => {
  const found = rules.find((r) => r.title === title);
  if (!found) throw new Error(`No rule ${title}`);
  return found;
};
const zero = { n: 0, atLeast: false };
const inputOf = (source: SecuritySource, edit?: (input: SecurityInput) => SecurityInput) => {
  const totals = { total: zero, high: zero };
  const input = { ...classify(source), totals: { spi: totals, upstream: totals, tests: totals } };
  return edit ? edit(input) : input;
};
const allRules = (input: SecurityInput) =>
  (["spi", "upstream", "tests"] as const).flatMap((id) => securityByRule(input, id).rules);

describe("By rule over the 16 Nov sweep", () => {
  const source = sweep1116Source();

  it("leads Shipped SPI code with the CSRF rule in 12 forks, ordered by worst, then high, then count", () => {
    const spi = lane(source, "spi");
    expect(spi.rules.map((r) => [r.severity, r.title, r.high, r.alerts.n])).toEqual([
      ["High", "Disabled Spring CSRF protection", 22, 22],
      ["High", "org.asynchttpclient:async-http-client", 6, 12],
      ["High", "Insertion of sensitive information into log files", 1, 1],
      ["High", "User-controlled data in arithmetic expression", 1, 1],
      ["Medium", "Log Injection", 0, 15],
      ["Medium", "org.json:json", 0, 1],
      ["Medium", "Pinned-Dependencies", 0, 1],
    ]);
    const [csrf] = spi.rules;
    expect(csrf && [text(csrf.sub), text(csrf.spread), text(csrf.age)]).toEqual([
      "Code scanning · CodeQL · 22 files",
      "12 forks",
      "263 d open",
    ]);
    expect(text(spi.summary)).toBe(
      "13 Dependabot, 40 code scanning · 7 rules and packages in 14 repositories",
    );
    expect([spi.tickMax, spi.barMax, text(spi.heading)]).toEqual([8, 22, "15 repositories"]);
    const tests = lane(source, "tests").rules.slice(0, 6);
    expect(tests.map((r) => [r.worst, r.high, r.alerts.n])).toEqual([
      ["critical", 12, 18],
      ["critical", 4, 6],
      ["critical", 1, 1],
      ["high", 14, 22],
      ["high", 10, 24],
      ["high", 10, 22],
    ]);
  });

  it("ends a tests-lane rule's second line with whose paths it sits in, and no other lane's", () => {
    const tests = lane(source, "tests").rules;
    expect(
      ["PyYAML", "pyjwt", "pyasn1", "Log Injection", "requests", "Branch-Protection"].map((title) =>
        text(rule(tests, title).sub),
      ),
    ).toEqual([
      "Dependabot · CVE-2020-14343 · SPI path",
      "Dependabot · 2 critical and 10 high, 6 lower · 9 advisories · SPI paths",
      "Dependabot · 4 advisories · upstream path",
      "Code scanning · CodeQL · 3 files · upstream paths",
      "Dependabot · 4 advisories · SPI and upstream paths",
      "Code scanning · Scorecard · SPI setting",
    ]);
    const shipped = [...lane(source, "spi").rules, ...lane(source, "upstream").rules];
    expect(shipped.filter((r) => /path|setting/.test(text(r.sub)))).toEqual([]);
  });

  it("names the repository holding most of a rule under its strip, and a rule in one repository by name", () => {
    const upstream = lane(source, "upstream").rules;
    expect(text(upstream[0]?.spread ?? [])).toBe("3 forks · 81 in crs-conversion");
    expect(text(rule(upstream, "Log Injection").spread)).toBe("5 forks");
    expect(text(rule(upstream, "org.apache.logging.log4j:log4j-core").spread)).toBe("entitlements");
    const single = lane(securityCase("single"), "spi").rules;
    expect(single.map((r) => text(r.spread))).toEqual(["partition"]);
  });

  it("gives every strip one tick per repository and an accessible name with its repositories and counts", () => {
    const [first] = lane(source, "upstream").rules;
    expect(first?.ticks.map((t) => t.repository)).toEqual(
      securityPane(source).repositories.map((r) => r.name),
    );
    expect(first?.ticks.find((t) => t.repository === "crs-conversion")).toMatchObject({
      read: true,
      alerts: 81,
      high: 81,
    });
    expect(text(first?.strip ?? [])).toBe(
      "User-controlled data in arithmetic expression by repository: crs-conversion 81, crs-catalog 12, unit 2. Arrow keys name a repository; Enter opens it.",
    );
    const guava = rule(lane(source, "tests").rules, "com.google.guava:guava");
    expect(guava.ticks.filter((t) => t.alerts).map((t) => text(t.name))).toEqual([
      "legal 3, 1 high",
      "indexer 6, 2 high",
      "search 6, 2 high",
      "workflow 3, 1 high",
      "indexer-queue 3, 1 high",
    ]);
    expect(text(guava.ticks[0]?.name ?? [])).toBe("partition: none");
  });

  it("words the fix as the decision bead says, and counts fix PRs open and closed unmerged", () => {
    const upstream = lane(source, "upstream").rules;
    const tests = lane(source, "tests").rules;
    const words = (r: SecurityRuleHead) => [text(r.fix), text(r.prs)];
    expect(words(rule(upstream, "com.google.guava:guava"))).toEqual([
      "first patched 33.7.2",
      "3 fix PRs closed unmerged",
    ]);
    expect(words(rule(upstream, "org.apache.logging.log4j:log4j-core"))).toEqual([
      "4 advisories, first patched 2.25.4",
      "1 fix PR closed unmerged",
    ]);
    expect(words(rule(tests, "com.fasterxml.jackson.core:jackson-databind"))).toEqual([
      "13 advisories, first patched 2.13.4 to 2.18.11",
      "1 fix PR open · 1 fix PR closed unmerged",
    ]);
    expect(words(rule(tests, "com.google.guava:guava"))).toEqual([
      "3 advisories, first patched 32.0.0-android to 33.7.2",
      "3 fix PRs open · 3 fix PRs closed unmerged",
    ]);
    expect(words(rule(lane(source, "spi").rules, "org.asynchttpclient:async-http-client"))).toEqual(
      ["no patched version", ""],
    );
    expect(rule(upstream, "Log Injection").fix).toEqual([]);
    const someWithout = inputOf(source, (input) => ({
      ...input,
      alerts: input.alerts.map((a) =>
        a.dependabot?.package === "org.jsoup:jsoup" && a.dependabot.fixed === "1.23.2"
          ? { ...a, dependabot: { ...a.dependabot, fixed: undefined } }
          : a,
      ),
    }));
    expect(text(rule(securityByRule(someWithout, "upstream").rules, "org.jsoup:jsoup").fix)).toBe(
      "2 advisories, first patched 1.23.1, some without",
    );
  });

  it("counts alerts opened within seven days as new this week, only while some are older", () => {
    const upstream = lane(source, "upstream").rules;
    expect(text(rule(upstream, "org.json:json").age)).toBe("7 d open · 1 new this week");
    expect(text(rule(lane(source, "spi").rules, "org.json:json").age)).toBe("6 d open");
  });
});

/** Which numbers a row draws carry ≥, named by the words that follow each count. */
function marks(row: SecurityRuleHead) {
  const found: [string, boolean][] = [];
  const label = (words: SecurityWords, field: (after: string, next: string) => string | null) =>
    words.forEach((part, i) => {
      if (typeof part === "string" || "code" in part) return;
      const after = words[i + 1];
      const next = words[i + 2];
      const name = field(
        typeof after === "string" ? after : "",
        typeof next === "string" ? next : "",
      );
      if (!name) throw new Error(`Unlabelled count in ${text(words)}`);
      found.push([name, part.atLeast]);
    });
  const subField = (after: string) =>
    /^ files?$/.test(after)
      ? "files"
      : /^ advisor(y|ies)/.test(after)
        ? "advisories"
        : /^ (critical|high|lower)/.test(after)
          ? "severity split"
          : null;
  label(row.sub, subField);
  label(row.fix, subField);
  label(row.spread, (after) =>
    /^ (forks?|repositor(y|ies))$/.test(after)
      ? "repositories"
      : /^ in /.test(after)
        ? "main"
        : null,
  );
  label(row.age, (after) =>
    after === " d open" ? "age" : after === " new this week" ? "new this week" : null,
  );
  label(row.prs, (after, next) =>
    /^ fix PRs?$/.test(after) ? (next === " open" ? "fix PRs open" : "fix PRs closed") : null,
  );
  found.push(["total", row.alerts.atLeast]);
  for (const tick of row.ticks)
    label(tick.name, (after) =>
      /^(, | high|)$/.test(after) ? (tick.read ? "tick, list read" : "tick, list not read") : null,
    );
  return found;
}

/**
 * What carries ≥ on a By rule row. A rule draws on one list, Dependabot for a package and code
 * scanning for a rule; "short" is that list unread in some repository.
 */
const CARRIES: Record<string, (short: boolean) => boolean> = {
  total: (short) => short,
  "severity split": (short) => short,
  files: (short) => short,
  advisories: (short) => short,
  repositories: (short) => short,
  age: (short) => short,
  "new this week": (short) => short,
  "fix PRs open": (short) => short,
  "fix PRs closed": (short) => short,
  "tick, list read": () => false,
  "tick, list not read": () => true,
};

const codeUnread = () =>
  inputOf(sweep1116Source(), (input) => ({
    ...input,
    repositories: input.repositories.map((r) =>
      r.name === "workflow" ? { ...r, read: { ...r.read, code: false } } : r,
    ),
  }));

const SCENARIOS: [string, () => SecurityInput][] = [
  ["the 16 Nov sweep", () => inputOf(sweep1116Source())],
  ["one scanner's list absent (partial)", () => inputOf(securityCase("partial"))],
  ["one repository's read failed, its lists retained", () => inputOf(securityCase("retained"))],
  ["every read failed, older lists retained", () => inputOf(securityCase("failed"))],
  ["only code scanning unread, in workflow", () => codeUnread()],
];

describe("≥ on a By rule row", () => {
  it.each(SCENARIOS)("follows the closed table over %s", (_name, build) => {
    const input = build();
    const seen = new Set<string>();
    for (const row of allRules(input)) {
      const short = input.repositories.some((r) => !r.read[row.list]);
      for (const [field, atLeast] of marks(row)) {
        seen.add(field);
        const carries = CARRIES[field];
        if (field === "main") {
          expect(short, `${row.key} names a main repository`).toBe(false);
          expect(atLeast).toBe(false);
          continue;
        }
        if (!carries) throw new Error(`No row in the table for ${field}`);
        expect(atLeast, `${row.key}: ${field}`).toBe(carries(short));
      }
    }
    expect(
      [...seen].filter((field) => field !== "main" && !field.startsWith("tick")).sort(),
    ).toEqual(
      Object.keys(CARRIES)
        .filter((field) => !field.startsWith("tick"))
        .sort(),
    );
  });

  it("leaves a package exact and a rule at least when only code scanning was not read", () => {
    const tests = securityByRule(codeUnread(), "tests").rules;
    const guava = rule(tests, "com.google.guava:guava");
    const csrf = rule(tests, "Disabled Spring CSRF protection");
    expect([guava.alerts, text(guava.spread)]).toEqual([{ n: 21, atLeast: false }, "5 forks"]);
    expect([csrf.alerts, text(csrf.spread)]).toEqual([{ n: 6, atLeast: true }, "≥3 forks"]);
    expect(text(csrf.strip)).toContain("workflow ≥4");
  });

  it("reads ≥1 fork for a rule in one repository while a list it draws on is unread", () => {
    const spi = lane(securityCase("partial"), "spi").rules;
    const arithmetic = rule(spi, "User-controlled data in arithmetic expression");
    expect(text(arithmetic.spread)).toBe("≥1 fork");
    expect(arithmetic.repositories).toEqual(["storage"]);
    expect(text(arithmetic.strip)).toBe(
      "User-controlled data in arithmetic expression by repository: storage 1; not read: workflow. Arrow keys name a repository; Enter opens it.",
    );
    expect(text(rule(spi, "Pinned-Dependencies").spread)).toBe("≥1 repository");
  });

  it("names no main repository while a list the rule draws on is unread", () => {
    const upstream = lane(securityCase("partial"), "upstream").rules;
    expect(text(upstream[0]?.spread ?? [])).toBe("≥3 forks");
    expect(text(lane(securityCase("partial"), "spi").summary)).toBe(
      "≥9 Dependabot, ≥29 code scanning · ≥6 rules and packages in ≥14 repositories",
    );
  });

  it("hatches a retained repository's tick and counts its alerts as at least", () => {
    const csrf = rule(
      securityByRule(inputOf(securityCase("retained")), "spi").rules,
      "Disabled Spring CSRF protection",
    );
    expect(csrf.ticks.find((t) => t.repository === "file")).toMatchObject({
      read: false,
      alerts: 2,
    });
    expect(text(csrf.strip)).toContain("file ≥2");
    expect(text(csrf.spread)).toBe("≥12 forks");
  });
});
