// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityRepoRow, SecurityWords } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { securityByRepository } from "../src/security/by-repo";
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

const zero = { n: 0, atLeast: false };
const inputOf = (source: SecuritySource): SecurityInput => {
  const totals = { total: zero, high: zero };
  return { ...classify(source), totals: { spi: totals, upstream: totals, tests: totals } };
};
const LANES = ["spi", "upstream", "tests"] as const;
const row = (rows: readonly SecurityRepoRow[], name: string) => {
  const found = rows.find((r) => r.repository === name);
  if (!found) throw new Error(`No row ${name}`);
  return found;
};

describe("By repository over the 16 Nov sweep", () => {
  const source = sweep1116Source();
  const lane = (id: (typeof LANES)[number]) => {
    const found = securityPane(source).lanes.find((l) => l.id === id);
    if (!found) throw new Error(`No lane ${id}`);
    return found.byRepository;
  };

  it("orders a lane by alerts, then high, then name, so the bars shrink down the list", () => {
    const upstream = lane("upstream");
    expect(upstream.rows.map((r) => [r.repository, r.alerts.n, r.high])).toEqual([
      ["crs-conversion", 82, 81],
      ["workflow", 21, 7],
      ["crs-catalog", 15, 14],
      ["entitlements", 10, 0],
      ["unit", 7, 2],
      ["file", 7, 1],
      ["search", 7, 1],
      ["indexer", 1, 1],
      ["indexer-queue", 1, 1],
      ["partition", 1, 1],
      ["legal", 1, 0],
      ["schema", 1, 0],
      ["storage", 1, 0],
    ]);
    expect(upstream.barMax).toBe(82);
    expect(text(upstream.clean)).toBe(
      "Nothing open in shipped upstream code: osdu-spi, osdu-spi-stack",
    );
    expect(upstream.cleanShort).toBeUndefined();
  });

  it("gives a row its high count, its total across the page by scanner and its top rules", () => {
    const upstream = lane("upstream").rows;
    const crs = row(upstream, "crs-conversion");
    expect([crs.program, crs.read, text(crs.sub), text(crs.page), text(crs.pageName)]).toEqual([
      false,
      true,
      "81 high",
      "133 open overall",
      "133 open overall: 51 Dependabot, 82 code scanning",
    ]);
    expect(text(crs.top)).toBe(
      "User-controlled data in arithmetic expression 81 · org.apache.sis.core:sis-metadata 1",
    );
    expect(text(row(upstream, "workflow").top)).toBe(
      "Log Injection 12 · Insertion of sensitive information into log files 5 · 3 more packages",
    );
    expect(text(row(lane("tests").rows, "file").top)).toBe(
      "commons-io:commons-io 2 · TrustManager that accepts all certificates 1 · 3 more rules and packages",
    );
    expect(text(row(lane("tests").rows, "unit").sub)).toBe("1 critical and 2 high");
    const spi = row(lane("spi").rows, "osdu-spi");
    expect([spi.program, text(spi.sub), text(spi.pageName)]).toEqual([
      true,
      "",
      "13 open overall: 0 Dependabot, 13 code scanning",
    ]);
  });

  it("lists a rule with more than six alerts in a repository by file, each file's pills reading as CodeQL #n", () => {
    const [arithmetic, sis] = row(lane("upstream").rows, "crs-conversion").rules;
    expect(arithmetic?.key).toBe("upstream:code:CodeQL:java/tainted-arithmetic");
    expect(arithmetic && text(arithmetic.words)).toBe("81 alerts");
    expect(arithmetic?.alerts).toEqual([]);
    expect(
      arithmetic?.files.map((f) => [text(f.words), f.alerts.length, f.more && text(f.more)]),
    ).toEqual([
      ["CRSConverter.java", 62, "62 CodeQL alerts"],
      ["GeoJsonBase.java", 8, "8 CodeQL alerts"],
      ["TrajectoryConverter.java", 5, "5 CodeQL alerts"],
      ["AzimuthCorrector.java", 2, undefined],
      ["GeoJsonLineString.java", 2, undefined],
      ["GeoJsonFeatureCollection.java", 1, undefined],
      ["GeoJsonGeometryCollection.java", 1, undefined],
    ]);
    const pills = arithmetic?.files.flatMap((f) => f.alerts) ?? [];
    expect(pills.every((p) => /^CodeQL #\d+$/.test(p.label) && p.heavy)).toBe(true);
    expect(pills[0]?.name).toMatch(/^CodeQL #\d+ in crs-conversion, high: crs-converter-core\//);
    expect([sis?.files, sis?.alerts.map((p) => p.label)]).toEqual([
      [],
      ["Dependabot #1 · CVE-2025-68280"],
    ]);
    const jackson = row(lane("tests").rows, "workflow").rules[0];
    expect([jackson?.title, jackson?.alerts.length, jackson?.files]).toEqual([
      "com.fasterxml.jackson.core:jackson-databind",
      24,
      [],
    ]);
    const log = row(lane("upstream").rows, "workflow").rules[1];
    expect(log?.alerts.map((p) => p.label)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^CodeQL #\d+ · \S+\.java$/)]),
    );
  });

  it("draws nothing for a lane with no alerts and cuts a long line of repositories with nothing", () => {
    const single = inputOf(securityCase("single"));
    expect(securityByRepository(single, "upstream")).toMatchObject({ rows: [], clean: [] });
    const spi = securityByRepository(single, "spi");
    expect(spi.rows.map((r) => r.repository)).toEqual(["partition"]);
    expect(text(spi.clean)).toMatch(
      /^Nothing open in shipped SPI code: entitlements, legal, .*, osdu-spi-stack$/,
    );
    expect(spi.cleanShort && [text(spi.cleanShort.words), text(spi.cleanShort.more)]).toEqual([
      "Nothing open in shipped SPI code: entitlements, legal, schema, file, storage, indexer and ",
      "8 more",
    ]);
  });
});

describe("By repository while a list was not read", () => {
  it("marks a repository with a list absent and keeps the counts from the list that was read exact", () => {
    const upstream = securityByRepository(inputOf(securityCase("partial")), "upstream").rows;
    const crs = row(upstream, "crs-conversion");
    expect([crs.read, crs.alerts, text(crs.sub), text(crs.pageName)]).toEqual([
      false,
      { n: 81, atLeast: true },
      "≥81 high · Dependabot not read",
      "≥82 open overall: ≥0 Dependabot, 82 code scanning",
    ]);
    expect(text(crs.top)).toBe(
      "User-controlled data in arithmetic expression 81 · from the lists read",
    );
    expect(text(crs.unread)).toBe("Dependabot alerts not read this sweep.");
    const workflow = row(upstream, "workflow");
    expect([text(workflow.sub), text(workflow.top), text(workflow.unread)]).toEqual([
      "≥2 high · code scanning not read",
      "org.jsoup:jsoup 2 · com.google.guava:guava 1 · ≥1 more package · from the lists read",
      "Code scanning alerts not read this sweep.",
    ]);
    expect(row(upstream, "crs-catalog")).toMatchObject({ read: true, unread: [] });
  });

  it("counts a retained list's alerts as at least and says they came from an earlier read", () => {
    const spi = securityByRepository(inputOf(securityCase("retained")), "spi").rows;
    const file = row(spi, "file");
    expect([file.alerts, text(file.top), text(file.unread)]).toEqual([
      { n: 6, atLeast: true },
      "Log Injection ≥4 · Disabled Spring CSRF protection ≥2 · from the lists read",
      "Dependabot and code scanning alerts not read this sweep; counted from an earlier read.",
    ]);
  });

  it("leaves a repository not read off the line of repositories with nothing, as a marked row", () => {
    const upstream = securityByRepository(inputOf(securityCase("failed")), "upstream");
    expect(upstream.clean).toEqual([]);
    expect(upstream.rows.slice(-2).map((r) => [r.repository, r.alerts, text(r.top)])).toEqual([
      ["osdu-spi", { n: 0, atLeast: true }, "none in the lists read"],
      ["osdu-spi-stack", { n: 0, atLeast: true }, "none in the lists read"],
    ]);
    const clean = securityByRepository(inputOf(sweep1116Source()), "upstream").clean;
    expect(text(clean)).toContain("osdu-spi, osdu-spi-stack");
  });
});

/** Which numbers a By repository lane draws carry ≥, each named and paired with what it draws on. */
function marks(input: SecurityInput, lane: (typeof LANES)[number]) {
  const found: [string, boolean, boolean][] = [];
  const by = securityByRepository(input, lane);
  for (const r of by.rows) {
    const repository = input.repositories.find((x) => x.name === r.repository);
    if (!repository) throw new Error(`No repository ${r.repository}`);
    const unread = !r.read;
    const listUnread = (key: string) =>
      !repository.read[key.includes(":dep:") ? "dependabot" : "code"];
    const each = (words: SecurityWords, name: (after: string, i: number) => [string, boolean]) => {
      let i = 0;
      words.forEach((part, at) => {
        if (typeof part === "string" || "code" in part) return;
        const after = words[at + 1];
        const [field, short] = name(typeof after === "string" ? after : "", i++);
        found.push([field, part.atLeast, short]);
      });
    };
    found.push(["row alerts", r.alerts.atLeast, unread]);
    each(r.sub, () => ["severity split", unread]);
    each(r.page, () => ["page total", unread]);
    each(r.pageName, (after) =>
      after === " Dependabot, "
        ? ["page Dependabot", !repository.read.dependabot]
        : after === " code scanning"
          ? ["page code scanning", !repository.read.code]
          : ["page total", unread],
    );
    each(r.top, (after, i) => {
      if (after.startsWith(" more ")) return ["more rules", unread];
      const rule = r.rules[i];
      if (!rule) throw new Error(`Unlabelled count in ${text(r.top)}`);
      return ["top rule count", listUnread(rule.key)];
    });
    for (const rule of r.rules) {
      const short = listUnread(rule.key);
      each(rule.words, () => ["rule count", short]);
      each(rule.name, () => ["rule count", short]);
      for (const file of rule.files) each(file.more ?? [], () => ["file alerts", short]);
    }
  }
  for (const part of by.cleanShort?.more ?? [])
    if (typeof part !== "string" && !("code" in part))
      found.push(["clean more", part.atLeast, false]);
  return found;
}

/** What carries ≥ in By repository; "short" is what the number draws on unread, as each row of `marks` pairs it. */
const CARRIES: Record<string, (short: boolean) => boolean> = {
  "row alerts": (short) => short,
  "severity split": (short) => short,
  "page total": (short) => short,
  "page Dependabot": (short) => short,
  "page code scanning": (short) => short,
  "top rule count": (short) => short,
  "more rules": (short) => short,
  "rule count": (short) => short,
  "file alerts": (short) => short,
  "clean more": () => false,
};

const SCENARIOS: [string, () => SecurityInput][] = [
  ["the 16 Nov sweep", () => inputOf(sweep1116Source())],
  ["one scanner's list absent (partial)", () => inputOf(securityCase("partial"))],
  ["one repository's read failed, its lists retained", () => inputOf(securityCase("retained"))],
  ["every read failed, older lists retained", () => inputOf(securityCase("failed"))],
  ["one alert in one repository", () => inputOf(securityCase("single"))],
];

describe("≥ in By repository", () => {
  it.each(SCENARIOS)("follows the closed table over %s", (_name, build) => {
    const input = build();
    const seen = new Set<string>();
    for (const lane of LANES)
      for (const [field, atLeast, short] of marks(input, lane)) {
        seen.add(field);
        const carries = CARRIES[field];
        if (!carries) throw new Error(`No row in the table for ${field}`);
        expect(atLeast, `${lane}: ${field}`).toBe(carries(short));
      }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("meets every row of the table across the scenarios", () => {
    const seen = new Set<string>();
    for (const [, build] of SCENARIOS) {
      const input = build();
      for (const lane of LANES) for (const [field] of marks(input, lane)) seen.add(field);
    }
    expect([...seen].sort()).toEqual(Object.keys(CARRIES).sort());
  });
});
