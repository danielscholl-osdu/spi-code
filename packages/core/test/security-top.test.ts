// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SecurityCount, SecurityPane, SecurityWords } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { classify } from "../src/security/classify";
import { type SecuritySource, securityPane } from "../src/security/index";
import { type SecurityCase, securityCase, sweep1116Source } from "./security-cases";

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
const counts = (words: SecurityWords) =>
  words.filter((part): part is SecurityCount => typeof part === "object" && "n" in part);

/** The 16 Nov sweep with only workflow's code scanning list absent: one scanner unread. */
function codeUnread(): SecuritySource {
  const source = sweep1116Source();
  const data = structuredClone(source.facts.security.data ?? {});
  delete data["Azure/osdu-spi-workflow"]?.code;
  return { ...source, facts: { ...source.facts, security: { ...source.facts.security, data } } };
}

const SOURCES: Record<"1116" | SecurityCase | "code unread", () => SecuritySource> = {
  "1116": sweep1116Source,
  partial: () => securityCase("partial"),
  retained: () => securityCase("retained"),
  failed: () => securityCase("failed"),
  clean: () => securityCase("clean"),
  single: () => securityCase("single"),
  "code unread": codeUnread,
};
const pane = (name: keyof typeof SOURCES) => securityPane(SOURCES[name]());
const lane = (p: SecurityPane, id: string) => {
  const found = p.lanes.find((l) => l.id === id);
  if (!found) throw new Error(`No lane ${id}`);
  return found;
};
const blocks = (p: SecurityPane) => p.lanes.flatMap((l) => l.figure.blocks);
const own = (p: SecurityPane, list: "dep" | "code") =>
  blocks(p)
    .filter((b) => b.rules.length === 1 && b.rules[0]?.includes(`:${list}:`))
    .map((b) => b.alerts);

describe("the top of the Security page over the 16 Nov sweep", () => {
  const p = pane("1116");

  it("reconciles with GitHub by scanner, then heads with high alerts in shipped code", () => {
    expect(text(p.page.totals)).toBe("411 open alerts: 211 Dependabot, 200 code scanning.");
    expect(text(p.page.headline)).toBe(
      "139 high alerts in shipped code. 30 are ours to fix, 22 from one rule in 12 forks.",
    );
    expect(p.page.opens).toBe("spi");
    expect(p.page.barMax).toBe(203);
    expect([p.page.banner, p.page.stub, p.page.legend.unread]).toEqual([[], [], undefined]);
  });

  it("concentrates on the SPI rule with the most high alerts, counted from the alerts", () => {
    const csrf = classify(sweep1116Source()).alerts.filter(
      (a) => a.lane === "spi" && a.key === "spi:code:CodeQL:java/spring-disabled-csrf-protection",
    );
    expect([
      csrf.filter((a) => a.high).length,
      new Set(csrf.map((a) => a.repository)).size,
    ]).toEqual([22, 12]);
  });

  it("names each bar, its total and its high count", () => {
    expect(
      p.lanes.map((l) => [l.figure.label, l.figure.who, l.total.n, l.high.n, text(l.figure.high)]),
    ).toEqual([
      ["Shipped SPI code", "Ours to fix", 53, 30, "30 high"],
      ["Shipped upstream code", "Upstream’s to fix, the fix arrives by sync", 155, 109, "109 high"],
      [
        "Tests, tooling and settings",
        "Not in the running service",
        203,
        87,
        "5 critical and 82 high",
      ],
    ]);
    expect(p.lanes.map((l) => l.figure.empty)).toEqual([[], [], []]);
  });

  it("gives a rule its own block at 4% of the longest lane, and every SPI rule with a high alert one", () => {
    const { alerts } = classify(sweep1116Source());
    const spiHigh = new Set(alerts.filter((a) => a.lane === "spi" && a.high).map((a) => a.key));
    const spiOwn = lane(p, "spi")
      .figure.blocks.filter((b) => b.rules.length === 1)
      .flatMap((b) => b.rules);
    expect([...spiHigh].every((key) => spiOwn.includes(key))).toBe(true);
    for (const l of p.lanes) {
      const grouped = l.figure.blocks.filter((b) => b.rules.length > 1);
      expect(grouped.length).toBeLessThanOrEqual(1);
      for (const b of l.figure.blocks.filter((x) => x.rules.length === 1))
        expect(b.alerts.n / p.page.barMax >= 0.04 || (l.id === "spi" && b.high > 0)).toBe(true);
      for (const b of grouped) {
        expect(b.alerts.n / p.page.barMax).toBeGreaterThan(0);
        expect(b.dividers).toHaveLength(b.rules.length - 1);
        expect(b.dividers).toEqual([...b.dividers].sort((x, y) => x - y));
      }
    }
    expect(text(lane(p, "spi").figure.blocks[0]?.name ?? [])).toBe(
      "Disabled Spring CSRF protection: 22 alerts, all high or critical, in 12 forks",
    );
  });
});

describe("blocks account for each lane", () => {
  it.each(["1116", "partial", "retained", "clean", "single", "code unread"] as const)(
    "in the %s sweep, every rule once and every alert and high alert once",
    (name) => {
      const source = SOURCES[name]();
      const p = securityPane(source);
      const { alerts } = classify(source);
      for (const l of p.lanes) {
        const keys = [...new Set(alerts.filter((a) => a.lane === l.id).map((a) => a.key))].sort();
        expect(l.figure.blocks.flatMap((b) => b.rules).sort()).toEqual(keys);
        expect(l.figure.blocks.reduce((n, b) => n + b.alerts.n, 0)).toBe(l.total.n);
        expect(l.figure.blocks.reduce((n, b) => n + b.high, 0)).toBe(l.high.n);
        const high = counts(l.figure.high).reduce((n, c) => n + c.n, 0);
        expect(high).toBe(l.high.n);
      }
    },
  );
});

// For each number on the top of the page: whether it carries ≥ in each sweep.
type Numbers = (p: SecurityPane) => SecurityCount[];
const NUMBERS: [
  string,
  Numbers,
  { "1116": boolean; partial: boolean; retained: boolean; "code unread": boolean },
][] = [
  [
    "the totals line's total",
    (p) => counts(p.page.totals).slice(0, 1),
    { "1116": false, partial: true, retained: true, "code unread": true },
  ],
  [
    "its Dependabot count",
    (p) => counts(p.page.totals).slice(1, 2),
    { "1116": false, partial: true, retained: true, "code unread": false },
  ],
  [
    "its code scanning count",
    (p) => counts(p.page.totals).slice(2, 3),
    { "1116": false, partial: true, retained: true, "code unread": true },
  ],
  [
    "every headline count",
    (p) => counts(p.page.headline),
    { "1116": false, partial: true, retained: true, "code unread": true },
  ],
  [
    "each lane total",
    (p) => p.lanes.map((l) => l.total),
    { "1116": false, partial: true, retained: true, "code unread": true },
  ],
  [
    "each lane high count",
    (p) => p.lanes.map((l) => l.high),
    { "1116": false, partial: true, retained: true, "code unread": true },
  ],
  [
    "each lane's high words",
    (p) => p.lanes.flatMap((l) => counts(l.figure.high)),
    { "1116": false, partial: true, retained: true, "code unread": true },
  ],
  [
    "the grouped blocks",
    (p) =>
      blocks(p)
        .filter((b) => b.rules.length > 1)
        .map((b) => b.alerts),
    { "1116": false, partial: true, retained: true, "code unread": true },
  ],
  [
    "a package's own block",
    (p) => own(p, "dep"),
    { "1116": false, partial: true, retained: true, "code unread": false },
  ],
  [
    "a code rule's own block",
    (p) => own(p, "code"),
    { "1116": false, partial: true, retained: true, "code unread": true },
  ],
];

describe("≥ sits only on a number an unread list could change", () => {
  it.each(
    NUMBERS.flatMap(([what, pick, expected]) =>
      (["1116", "partial", "retained", "code unread"] as const).map(
        (name) => [what, name, pick, expected[name]] as const,
      ),
    ),
  )("%s in the %s sweep", (_what, name, pick, atLeast) => {
    const numbers = pick(pane(name));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.map((c) => c.atLeast)).toEqual(numbers.map(() => atLeast));
  });
});

describe("a list not read", () => {
  it("is named once in the banner, its stub and the legend when one list of a repository was not read", () => {
    const p = pane("partial");
    expect(text(p.page.banner)).toBe(
      "2 lists not read: code scanning alerts in workflow, Dependabot alerts in crs-conversion. Counts marked ≥ may be higher.",
    );
    expect(text(p.page.stub)).toBe(
      "Not read: code scanning alerts in workflow, Dependabot alerts in crs-conversion",
    );
    expect(p.page.legend.unread).toBe("Not read");
    expect(text(p.page.headline)).toBe(
      "≥129 high alerts in shipped code. ≥25 are ours to fix, ≥20 from one rule in ≥11 forks.",
    );
  });

  it("names the repository alone when its whole read failed and its lists were kept", () => {
    const p = pane("retained");
    expect(text(p.page.banner)).toBe(
      "2 lists not read: file (counted from an earlier read). Counts marked ≥ may be higher.",
    );
    expect(text(p.page.stub)).toBe("Not read: file");
  });

  it("says Security not read and names each list when no list was read, with no counts", () => {
    const p = pane("failed");
    expect(p.read).toBe(false);
    expect([p.page.totals, ...p.lanes.map((l) => l.figure.blocks)]).toEqual([[], [], [], []]);
    expect(text(p.page.headline)).toBe("Security not read.");
    expect(text(p.page.banner)).toMatch(
      /^30 lists not read: partition \(counted from an earlier read\), entitlements \(counted from an earlier read\), .*\.$/,
    );
    expect(text(p.page.banner)).not.toContain("≥");
  });
});

describe("a lane with nothing", () => {
  it("says Nothing open once in its bar, and the page opens on the first shipped lane with alerts", () => {
    const p = pane("clean");
    const spi = lane(p, "spi");
    expect([spi.figure.empty, spi.figure.blocks, spi.figure.high]).toEqual([
      ["Nothing open"],
      [],
      [],
    ]);
    expect(text(p.page.headline)).toBe("109 high alerts in shipped code, none in SPI code.");
    expect(p.page.opens).toBe("upstream");
  });

  it("says Nothing open in the lists read while a list was not read", () => {
    const source = securityCase("partial");
    const data = structuredClone(source.facts.security.data ?? {});
    for (const lists of Object.values(data)) {
      lists.dependabot = lists.dependabot && [];
      lists.code = lists.code && [];
    }
    const p = securityPane({
      ...source,
      facts: { ...source.facts, security: { ...source.facts.security, data } },
    });
    expect(p.lanes.map((l) => l.figure.empty)).toEqual([
      ["Nothing open in the lists read"],
      ["Nothing open in the lists read"],
      ["Nothing open in the lists read"],
    ]);
    expect(text(p.page.totals)).toBe("No open alerts in the lists read.");
    expect(text(p.page.headline)).toBe("Nothing open in shipped code in the lists read.");
  });
});

it("says one alert, one rule and one repository in the singular", () => {
  const p = pane("single");
  expect(text(p.page.totals)).toBe("1 open alert: 1 Dependabot.");
  expect(text(p.page.headline)).toBe("1 high alert in shipped code. 1 is ours to fix.");
  const spi = lane(p, "spi");
  expect(text(spi.figure.high)).toBe("1 high");
  expect(spi.figure.blocks.map((b) => text(b.name))).toEqual([
    "widget: 1 alert, high or critical, in 1 fork",
  ]);
  expect(p.page.opens).toBe("spi");
});
