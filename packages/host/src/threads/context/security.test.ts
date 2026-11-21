// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { SecurityPane, ViewSnapshot } from "@spi-code/contracts";
import { type CodeAlertFact, HELP_MAX, parseCodeAlert } from "@spi-code/core";
import { createToolOutputRedactor, journalOutputRedactor } from "@spi-code/threads";
import { describe, expect, it } from "vitest";
import {
  SECURITY_FIXTURES,
  type SecurityFixture,
  securitySweep,
} from "../../../test/watch/security-fixture.js";
import { fixtureInput, recordedSnapshotPath } from "../../../test/watch/snapshot-fixture.js";
import { FakeSession } from "../../testing/fake-session.js";
import { buildPermissionGate } from "../../tools/permission-gate.js";
import { SPI_RESULT_BYTE_BUDGET, spiReadTools, spiToolProvider } from "../../tools/spi-reads.js";
import { projectWatch } from "../../watch/project.js";
import { areaEnvelopes } from "../../watch/provenance.js";
import { chipFromSweep } from "./draft.js";
import type { SpiRedactor } from "./redaction.js";
import {
  findRule,
  SECURITY_CHIP_BYTE_BUDGET,
  TITLE_MAX_CHARS,
  unreadLists as unreadListsOf,
  wordsText,
} from "./security.js";
import { latestSweep, type SavedSweep } from "./sweep.js";

const recorded: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));

/** The recorded snapshot carrying a scenario's pane, with the security area its records give. */
function scenario(name: SecurityFixture, scanned?: (alert: CodeAlertFact) => CodeAlertFact) {
  const { pane, records, now } = securitySweep(name, scanned);
  const security = areaEnvelopes({ security: records }, () => 3_600_000, now).find(
    ({ area }) => area === "security",
  );
  const view: ViewSnapshot = {
    ...recorded,
    security: pane,
    areas: recorded.areas.map((entry) =>
      entry.area === "security" && security ? security : entry,
    ),
  };
  const sweep: SavedSweep = { view, reads: { security: records }, inspect: async () => undefined };
  return { pane, view, sweep };
}

async function chip(sweep: SavedSweep, id: string, redactor: SpiRedactor = journalOutputRedactor) {
  const outcome = await chipFromSweep(() => sweep, id, redactor);
  if (!outcome.ok) throw new Error(`${id}: ${outcome.reason}`);
  return outcome.chip;
}

async function tool(
  sweep: SavedSweep,
  args: object = {},
  redactor: SpiRedactor = journalOutputRedactor,
) {
  const tools = spiToolProvider(spiReadTools(() => sweep, redactor)).offer();
  const session = new FakeSession({
    tools,
    availableTools: tools.map(({ name }) => `custom:${name}`),
    onPermissionRequest: buildPermissionGate(),
  });
  const output = await session.callTool("spi_security", args);
  if (typeof output !== "string") throw new Error("spi_security answered no text");
  return { text: output, value: JSON.parse(output) };
}

/** Help as long as a sweep keeps it whole, in one-byte and three-byte characters, and five CWEs. */
const HELP = {
  none: "",
  ascii: `${"Untrusted input reaches a sink without being checked first, so a caller can change what the call does. ".repeat(3).slice(0, 299).trimEnd()}.`,
  wide: "安全".repeat(150),
} as const;
const CWES = ["cwe-079", "cwe-116", "cwe-020", "cwe-1333", "cwe-400"];
const withHelp =
  (help: string) =>
  (alert: CodeAlertFact): CodeAlertFact =>
    help
      ? (parseCodeAlert({
          ...alert,
          fullDescription: help,
          tags: ["security", ...CWES.map((id) => `external/cwe/${id}`)],
        }) ?? alert)
      : alert;
const times = (text: string, part: string) => text.split(part).length - 1;

const rulesOf = (pane: SecurityPane) => pane.lanes.flatMap(({ byRule }) => byRule.rules);
const mostWhere = (pane: SecurityPane) =>
  [...rulesOf(pane)].sort((a, b) => b.opened.where.length - a.opened.where.length)[0];

describe.each(SECURITY_FIXTURES)("Security's context on the %s scenario", (name) => {
  const { pane, sweep } = scenario(name);

  it("packs the place within 2,000 UTF-8 bytes and the tool within 12,000", async () => {
    const place = await chip(sweep, "place:security");
    expect(place.bytes).toBe(Buffer.byteLength(place.content));
    expect(place.bytes).toBeLessThanOrEqual(SECURITY_CHIP_BYTE_BUDGET);
    const read = await tool(sweep);
    expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(SPI_RESULT_BYTE_BUDGET);
    const rule = mostWhere(pane);
    if (!rule) return;
    const one = await chip(sweep, `security-rule:${rule.key}`);
    expect(one.bytes).toBeLessThanOrEqual(SECURITY_CHIP_BYTE_BUDGET);
    expect(one.chip).toMatchObject({ kind: "security rule", title: rule.title });
    const detail = await tool(sweep, { rule: rule.key });
    expect(Buffer.byteLength(detail.text)).toBeLessThanOrEqual(SPI_RESULT_BYTE_BUDGET);
    expect(detail.value).toMatchObject({ rule: rule.key, title: rule.title });
  });

  it.each(Object.keys(HELP) as (keyof typeof HELP)[])(
    "packs every rule's chip within 2,000 UTF-8 bytes and its tool within 12,000, with %s help",
    async (kind) => {
      const help = HELP[kind];
      const { pane, sweep } = scenario(name, withHelp(help));
      for (const rule of rulesOf(pane)) {
        const id = `security-rule:${rule.key}`;
        const one = await chip(sweep, id);
        expect(one.bytes, rule.key).toBeLessThanOrEqual(SECURITY_CHIP_BYTE_BUDGET);
        expect((await chip(sweep, id)).content, rule.key).toBe(one.content);
        expect(one.chip.evidence, rule.key).toEqual([findRule(pane, rule.key)?.at]);
        const reading = one.chip.reading as {
          facts: { label: string; words: string }[];
          where: unknown[];
          advisories?: unknown[];
          leftOut?: { facts?: number; where?: number };
        };
        if (one.trimmed) expect(reading, rule.key).toHaveProperty("leftOut");
        const code = help !== "" && rule.key.includes(":code:");
        if (code && reading.facts.length > 0)
          expect(reading.facts[0], rule.key).toEqual({ label: "What it is", words: help });
        if (reading.leftOut?.facts) {
          expect(reading.where, rule.key).toEqual([]);
          expect(reading.advisories ?? [], rule.key).toEqual([]);
        }
        if (code && !one.trimmed) {
          expect(times(one.content, help), rule.key).toBe(1);
          expect(one.content, rule.key).toContain(`CWE-79, CWE-116, CWE-20, CWE-1333, CWE-400`);
        }
        const detail = await tool(sweep, { rule: rule.key });
        expect(Buffer.byteLength(detail.text), rule.key).toBeLessThanOrEqual(
          SPI_RESULT_BYTE_BUDGET,
        );
        if (code) expect(times(detail.text, help), rule.key).toBe(1);
      }
      const read = await tool(sweep);
      expect(Buffer.byteLength(read.text)).toBeLessThanOrEqual(SPI_RESULT_BYTE_BUDGET);
    },
  );

  it("tells Copilot the page's counts and lane words, with ≥ where the page has it", async () => {
    const { chip: packed } = await chip(sweep, "place:security");
    const reading = packed.reading as Record<string, unknown>;
    expect(reading.headline).toBe(wordsText(pane.page.headline));
    if (pane.page.banner.length) expect(reading.banner).toBe(wordsText(pane.page.banner));
    if (!pane.read) {
      expect(reading).not.toHaveProperty("lanes");
      return;
    }
    expect(reading.totals).toBe(wordsText(pane.page.totals));
    expect(reading.lanes).toEqual(
      pane.lanes.map((lane) => ({
        lane: lane.id,
        label: lane.figure.label,
        who: lane.figure.who,
        alerts: `${lane.total.atLeast ? "≥" : ""}${lane.total.n}`,
        ...(lane.figure.high.length ? { high: wordsText(lane.figure.high) } : {}),
        ...(lane.figure.empty.length ? { empty: wordsText(lane.figure.empty) } : {}),
      })),
    );
    const rows = new Map(rulesOf(pane).map((rule) => [rule.key, rule]));
    for (const line of reading.rules as { rule: string; alerts: string; spread?: string }[]) {
      const row = rows.get(line.rule);
      expect(line.alerts).toBe(wordsText(row ? [row.alerts] : []));
      expect(line.spread ?? "").toBe(wordsText(row?.spread ?? []));
    }
  });

  it("keeps every rule key whole through the redactor, so a refreshed chip still finds its rule", async () => {
    for (const rule of rulesOf(pane)) {
      const subject = `security-rule:${rule.key}`;
      expect(journalOutputRedactor.value(subject)).toBe(subject);
      expect((await chip(sweep, subject)).id).toBe(subject);
    }
  });

  it("tells Copilot a rule's facts, files and summaries only where core kept them as written", async () => {
    for (const rule of rulesOf(pane)) {
      const { value } = await tool(sweep, { rule: rule.key });
      if (value.leftOut) continue;
      const { facts, where } = rule.opened;
      expect(
        value.facts.map(({ label }: { label: string }) => label),
        rule.key,
      ).toEqual(facts.filter(({ verbatim }) => verbatim).map(({ label }) => label));
      expect(value.where, rule.key).toHaveLength(where.length);
      for (const [index, line] of where.entries())
        expect(value.where[index].files, rule.key).toBe(
          line.verbatim && line.files.length > 0 ? wordsText(line.files) : undefined,
        );
      const all = facts.flatMap(({ advisories }) =>
        advisories ? [...advisories.preview, ...advisories.rest] : [],
      );
      expect(value.advisories ?? [], rule.key).toEqual(
        all.map((advisory) => ({
          id: advisory.id,
          ...(advisory.verbatim ? { words: wordsText(advisory.words) } : {}),
          fix: wordsText(advisory.fix),
        })),
      );
    }
  });

  it("names each list not read and is partial while one is", async () => {
    const { chip: packed } = await chip(sweep, "place:security");
    const lists = pane.unread.map(({ repository }) => repository);
    for (const repository of lists)
      expect(
        (packed.notRead as string[]).some((entry) => entry.endsWith(` in ${repository}`)),
      ).toBe(true);
    if (lists.length) expect(packed.completeness).toBe("partial");
  });
});

describe("Security's read state, as the page has it", () => {
  const STATES = {
    "1116": "read",
    partial: "partly read",
    retained: "partly read",
    failed: "not read",
    clean: "read",
    single: "read",
  } as const;

  it.each(SECURITY_FIXTURES)("reads the %s scenario as its pane does", async (name) => {
    const { pane, sweep } = scenario(name);
    const state = STATES[name];
    const rule = rulesOf(pane)[0]?.key ?? "spi:dep:none";
    for (const args of [{}, { rule }]) {
      const { value } = await tool(sweep, args);
      expect(value.read, JSON.stringify(args)).toBe(state);
      expect(value.listsNotRead ?? [], JSON.stringify(args)).toHaveLength(pane.unread.length);
    }
    for (const id of ["place:security", `security-rule:${rule}`])
      expect((await chip(sweep, id)).chip.completeness, id).toBe(
        state === "read" ? "complete" : "partial",
      );
  });

  it("tells Copilot what the page shows before the first read, naming every list", async () => {
    const { pane, view, sweep } = scenario("failed");
    const unread: SavedSweep = {
      ...sweep,
      view: {
        ...view,
        areas: view.areas.map((entry) =>
          entry.area === "security"
            ? { ...entry, envelope: { source: "security", state: "unread" as const } }
            : entry,
        ),
      },
    };
    expect(pane.unread).toHaveLength(15);
    for (const args of [{}, { rule: "spi:dep:any" }]) {
      const { value } = await tool(unread, args);
      expect(value.read).toBe("not read");
      expect(value.listsNotRead).toHaveLength(15);
    }
    expect((await tool(unread)).value.headline).toBe("Security not read.");
    const place = await chip(unread, "place:security");
    expect(place.chip.reading).toMatchObject({ headline: "Security not read." });
    expect(place.chip.notRead).toEqual(expect.arrayContaining(unreadListsOf(pane)));
  });

  it("reads a saved snapshot with no pane as not read, whatever its area says", async () => {
    const { view, sweep } = scenario("1116");
    const { security: _, ...bare } = view;
    const none: SavedSweep = { ...sweep, view: bare };
    for (const args of [{}, { rule: "spi:dep:any" }]) {
      const { value } = await tool(none, args);
      expect(value).toMatchObject({ read: "not read", reading: "not read" });
      expect(value).not.toHaveProperty("at");
    }
    for (const id of ["place:security", "security-rule:spi:dep:any"]) {
      const { chip: packed } = await chip(none, id);
      expect(packed).toMatchObject({ reading: "not read", completeness: "partial", evidence: [] });
    }
  });
});

describe("trimming Security's chips", () => {
  it.each(["partial", "failed"] as const)(
    "cuts the %s place chip the same way twice, keeping By rule's first rules in page order",
    async (name) => {
      const { pane, sweep } = scenario(name);
      const first = await chip(sweep, "place:security");
      const again = await chip(sweep, "place:security");
      expect(again.content).toBe(first.content);
      const reading = first.chip.reading as { rules?: { rule: string }[]; leftOut?: object };
      const all = rulesOf(pane).map(({ key }) => key);
      const kept = (reading.rules ?? []).map(({ rule }) => rule);
      expect(kept).toEqual(all.slice(0, kept.length));
      if (kept.length < all.length) {
        expect(first.trimmed).toBe(true);
        expect(reading.leftOut).toEqual({ rules: all.length - kept.length });
        expect(first.chip.trimmed).toBe(
          `Over 2000 UTF-8 bytes, so this chip left out ${all.length - kept.length} of ${all.length} rules. Use spi_security for the rest.`,
        );
      } else expect(first.trimmed).toBe(false);
      if (name === "failed") {
        expect(pane.read).toBe(false);
        expect(first.chip.reading).toEqual({
          headline: "Security not read.",
          banner: wordsText(pane.page.banner),
        });
        expect(first.chip.notRead).toHaveLength(pane.unread.length + 1);
      }
    },
  );

  it("cuts a rule chip's where lines from the last, the same way twice", async () => {
    const { pane, sweep } = scenario("partial");
    const rule = mostWhere(pane);
    if (!rule) throw new Error("The partial scenario has no rule");
    const first = await chip(sweep, `security-rule:${rule.key}`);
    expect((await chip(sweep, `security-rule:${rule.key}`)).content).toBe(first.content);
    const where = (first.chip.reading as { where: { repository: string }[] }).where;
    const lines = rule.opened.where.map(({ repository }) => repository);
    expect(where.map(({ repository }) => repository)).toEqual(lines.slice(0, where.length));
    expect(first.trimmed).toBe(where.length < lines.length);
  });

  it("keeps whole rules in the tool's 12,000 bytes and counts those left out", async () => {
    const { pane, sweep } = scenario("partial");
    const { value } = await tool(sweep);
    const all = rulesOf(pane).map(({ key }) => key);
    const kept = (value.rules as { rule: string }[]).map(({ rule }) => rule);
    expect(kept).toEqual(all.slice(0, kept.length));
    expect(value.leftOut ?? {}).toEqual(
      kept.length < all.length ? { rules: all.length - kept.length } : {},
    );
    expect(value.listsNotRead).toHaveLength(pane.unread.length);
  });
});

describe("scanner text", () => {
  const known = "fixture-scanner-credential";
  const hub = ["gh", "p_", "FAKE".repeat(9)].join("");
  const { journal } = createToolOutputRedactor([known]);
  const { pane, sweep } = scenario(
    "1116",
    (alert) =>
      parseCodeAlert({
        ...alert,
        description: `Hard-coded ${hub} in config`,
        fullDescription: `Rotate ${known} before release.`,
      }) ?? alert,
  );
  const code = rulesOf(pane).find(({ key }) => key.includes(":code:"));

  it("passes the redactor before it reaches Copilot, in the chips and the tool", async () => {
    if (!code) throw new Error("The 1116 scenario has no code rule");
    const place = await chip(sweep, "place:security", journal);
    const titles = (place.chip.reading as { rules: { rule: string; title: string }[] }).rules;
    expect(titles.find(({ rule }) => rule === code.key)?.title).toBe(
      "Hard-coded [redacted] in config",
    );
    const one = await chip(sweep, `security-rule:${code.key}`, journal);
    const detail = await tool(sweep, { rule: code.key }, journal);
    const texts = [place.content, one.content, (await tool(sweep, {}, journal)).text, detail.text];
    for (const text of texts) {
      expect(text).not.toContain(hub);
      expect(text).not.toContain(known);
      expect(text).toContain("Hard-coded [redacted] in config");
    }
    for (const text of [one.content, detail.text])
      expect(text).toContain("Rotate [redacted] before release.");
  });

  it("leaves no part of a known credential the help's cut falls across", async () => {
    const secret = "Qzfixture-scanner-credential-across-the-cap";
    const lead = `${"word ".repeat(59)}a `;
    const { journal: known } = createToolOutputRedactor([secret]);
    const across = scenario("1116", (alert) =>
      alert.rule === code?.key.split(":").at(-1)
        ? (parseCodeAlert({ ...alert, fullDescription: `${lead}${secret} tail` }) ?? alert)
        : alert,
    );
    expect([...lead].length).toBeLessThan(HELP_MAX - 1);
    if (!code) throw new Error("The 1116 scenario has no code rule");
    const texts = [
      (await chip(across.sweep, `security-rule:${code.key}`, known)).content,
      (await tool(across.sweep, { rule: code.key }, known)).text,
      (await tool(across.sweep, {}, known)).text,
    ];
    for (const text of texts) expect(text).not.toContain(secret.slice(0, 2));
    expect(findRule(across.pane, code.key)?.rule.opened.help).toBe(`${lead.trimEnd()}…`);
  });

  it("withholds the chips and the tool when the redactor cannot handle a value", async () => {
    if (!code) throw new Error("The 1116 scenario has no code rule");
    const refusing = {
      value: () => {
        throw new Error("fixture-private-value");
      },
    };
    for (const id of ["place:security", `security-rule:${code.key}`])
      expect(await chipFromSweep(() => sweep, id, refusing)).toEqual({
        ok: false,
        reason: "Context chip withheld.",
      });
    for (const args of [{}, { rule: code.key }]) {
      const run = tool(sweep, args, refusing);
      await expect(run).rejects.toThrow("SPI tool output withheld.");
      await expect(run).rejects.not.toThrow("fixture-private-value");
    }
  });
});

describe("scanner text Copilot is told about Security", () => {
  const secret = "Qzfixture spaced-scanner-credential";
  const { journal } = createToolOutputRedactor([secret]);
  const titleLead = `${"w ".repeat(50)}`;
  const title = `${titleLead}${secret} tail of the long title`;
  const helpLead = `${"word ".repeat(57)}fill `;
  const prefix = secret.slice(0, secret.indexOf(" "));
  const target = rulesOf(scenario("1116").pane).find(({ key }) => key.includes(":code:"));
  if (!target) throw new Error("The 1116 scenario has no code rule");
  const ruleId = target.key.split(":").slice(3).join(":");
  const tool_ = target.key.split(":")[2] ?? "";

  /** The six things Copilot is told about Security, with campaign subjects saved for this rule and for none. */
  async function outputs(sweep: SavedSweep, key: string, redactor: SpiRedactor = journal) {
    const fact = `${tool_}: ${ruleId}`;
    const none = "Fixture: no-such-rule";
    const view: ViewSnapshot = {
      ...sweep.view,
      campaigns: [
        ...sweep.view.campaigns,
        ...[fact, none].map((entry) => ({
          id: `campaign:security:${encodeURIComponent(entry)}`,
          kind: "security" as const,
          fact: entry,
          forks: ["legal", "storage"],
        })),
      ],
    };
    const saved: SavedSweep = { ...sweep, view };
    return {
      place: (await chip(saved, "place:security", redactor)).content,
      rule: (await chip(saved, `security-rule:${key}`, redactor)).content,
      campaign: (await chip(saved, `campaign:security:${encodeURIComponent(fact)}`, redactor))
        .content,
      fallback: (await chip(saved, `campaign:security:${encodeURIComponent(none)}`, redactor))
        .content,
      tool: (await tool(saved, {}, redactor)).text,
      ruleTool: (await tool(saved, { rule: key }, redactor)).text,
    };
  }

  /** A pane saved before core said what it changed: no row says cut and nothing says verbatim. */
  const unflagged = (pane: SecurityPane): SecurityPane => ({
    ...pane,
    lanes: pane.lanes.map((lane) => ({
      ...lane,
      byRule: {
        ...lane.byRule,
        rules: lane.byRule.rules.map(({ cut: _, ...rule }) => ({
          ...rule,
          opened: {
            ...rule.opened,
            facts: rule.opened.facts.map(({ verbatim: _v, ...fact }) => fact),
          },
        })),
      },
    })),
  });

  const cases = {
    "cut by the collector at this read": {
      alert: (alert: CodeAlertFact) =>
        parseCodeAlert({
          ...alert,
          description: title,
          fullDescription: `${helpLead}${secret} tail`,
        }) ?? alert,
      saved: (pane: SecurityPane) => pane,
    },
    "cut by an older collector, in a pane saved before the flags": {
      alert: (alert: CodeAlertFact) => ({
        ...alert,
        description: title,
        fullDescription: `${`${helpLead}${secret} tail`.slice(0, HELP_MAX - 1).trimEnd()}…`,
      }),
      saved: unflagged,
    },
    "ending in the cut's ellipsis, though marked verbatim": {
      alert: (alert: CodeAlertFact): CodeAlertFact => ({
        ...alert,
        description: title,
        fullDescription: `${`${helpLead}${secret} tail`.slice(0, HELP_MAX - 1).trimEnd()}…`,
        verbatim: true,
      }),
      saved: (pane: SecurityPane): SecurityPane => ({
        ...pane,
        lanes: pane.lanes.map((lane) => ({
          ...lane,
          byRule: {
            ...lane.byRule,
            rules: lane.byRule.rules.map(({ cut: _, ...rule }) => rule),
          },
        })),
      }),
    },
  } as const;

  it.each(Object.keys(cases) as (keyof typeof cases)[])(
    "tells Copilot the rule key for an over-long title, and no help, when the help was %s",
    async (kind) => {
      expect([...titleLead].length).toBeLessThan(TITLE_MAX_CHARS);
      expect([...`${titleLead}${secret}`].length).toBeGreaterThan(TITLE_MAX_CHARS);
      const { alert, saved } = cases[kind];
      const cutOne = (fact: CodeAlertFact) =>
        fact.rule === ruleId && fact.tool === tool_ ? alert(fact) : fact;
      const { pane, view, sweep } = scenario("1116", cutOne);
      const held = saved(pane);
      const row = findRule(held, target.key)?.rule;
      if (!row) throw new Error(`${target.key} is gone`);
      expect(row.title).toBe(title);
      expect(row.opened.help).toContain(prefix);
      if (held !== pane) expect(row).not.toHaveProperty("cut");
      const what = row.opened.facts.find(({ label }) => label === "What it is");
      expect(what?.verbatim).toBe(kind.includes("verbatim") ? true : undefined);
      const told = await outputs({ ...sweep, view: { ...view, security: held } }, target.key);
      for (const [name, text] of Object.entries(told)) {
        expect(text, name).not.toContain(prefix);
        expect(text, name).not.toContain(helpLead.trimEnd());
        expect(text, name).not.toContain(titleLead.trimEnd());
      }
      const ruleChip = JSON.parse(told.rule) as { title: string; reading: { title: string } };
      expect(ruleChip.title).toBe(target.key);
      expect(ruleChip.reading.title).toBe(target.key);
      const placeRules = (
        JSON.parse(told.place) as { reading: { rules: { rule: string; title: string }[] } }
      ).reading.rules;
      expect(placeRules.find(({ rule }) => rule === target.key)?.title).toBe(target.key);
      for (const name of ["campaign", "tool", "ruleTool"] as const)
        expect(told[name], name).toContain(`"title":${JSON.stringify(target.key)}`);
    },
  );

  it.each(["\t", "\n", "\r\n", "\u200b ", "\u2028"])(
    "goes by the rule key when the title gives a credential's space as %j",
    async (space) => {
      const spaced = `Hard-coded ${secret.replace(" ", space)} in config`;
      const { sweep } = scenario("1116", (alert) =>
        alert.rule === ruleId && alert.tool === tool_ ? { ...alert, description: spaced } : alert,
      );
      for (const [name, text] of Object.entries(await outputs(sweep, target.key)))
        expect(text, name).not.toContain(prefix);
      expect((await chip(sweep, `security-rule:${target.key}`, journal)).chip.title).toBe(
        target.key,
      );
    },
  );

  it("goes by the rule key when the title holds nothing to show", async () => {
    const { sweep } = scenario("1116", (alert) =>
      alert.rule === ruleId && alert.tool === tool_
        ? { ...alert, description: "\u200b \t" }
        : alert,
    );
    expect((await chip(sweep, `security-rule:${target.key}`)).chip.title).toBe(target.key);
  });

  const emoji = "\u{1F600}";
  /** What the scanner writes, and whether Copilot is told it exactly as written. */
  const awkward: { name: string; title?: string; help?: string; sent: boolean }[] = [
    { name: "a plain title", title: "Plain scanner title", sent: true },
    { name: "a title with a tab", title: "Tab\tinside", sent: false },
    { name: "a title with CRLF", title: "First\r\nsecond", sent: false },
    { name: "a title on two lines", title: "First\nsecond", sent: false },
    { name: "a title with a line separator", title: "First\u2028second", sent: false },
    { name: "a title with NBSP", title: "No\u00a0break", sent: true },
    { name: "a title with a zero-width space", title: "Zero\u200bwidth", sent: false },
    { name: "a title with backticks", title: "`TrustManager` that accepts all", sent: true },
    { name: "a title with outer spaces", title: " Leading and trailing ", sent: true },
    { name: "a title ending in an ellipsis", title: "Ends in an ellipsis…", sent: true },
    { name: "a title at the character bound", title: "x".repeat(TITLE_MAX_CHARS), sent: true },
    { name: "a title one over it", title: "x".repeat(TITLE_MAX_CHARS + 1), sent: false },
    {
      name: "a title at the byte bound",
      title: `${emoji.repeat(89)}abcd`,
      sent: true,
    },
    { name: "a title one byte over it", title: `${emoji.repeat(89)}abcde`, sent: false },
    {
      name: "a title of three-byte characters at both bounds",
      title: "安".repeat(120),
      sent: true,
    },
    { name: "plain help", help: "Plain scanner help.", sent: true },
    { name: "help with a tab", help: "A\ttab.", sent: false },
    { name: "help with CRLF", help: "First\r\nsecond.", sent: false },
    {
      name: "help on several lines",
      help: "password: |\n  QzFixtureOnlyYamlPassword",
      sent: false,
    },
    { name: "help with NBSP", help: "No\u00a0break.", sent: false },
    { name: "help with a zero-width space", help: "Zero\u200bwidth.", sent: false },
    { name: "help with backticks", help: "Uses `eval` on input.", sent: false },
    { name: "help with outer spaces", help: " Leading and trailing. ", sent: false },
    { name: "help ending in an ellipsis", help: "Ends in an ellipsis…", sent: false },
    { name: "help at its bound", help: "y".repeat(HELP_MAX), sent: true },
    { name: "help one over it", help: "y".repeat(HELP_MAX + 1), sent: false },
    { name: "help cut at a space", help: "word ".repeat(80).trimEnd(), sent: false },
    { name: "no help", help: "", sent: false },
  ];

  it.each(awkward)(
    "tells Copilot $name exactly as written after one redaction, or the rule key and no help",
    async ({ title: raw, help, sent }) => {
      const { pane, sweep } = scenario("1116", (alert) =>
        alert.rule === ruleId && alert.tool === tool_
          ? (parseCodeAlert({
              ...alert,
              ...(raw === undefined ? {} : { description: raw }),
              ...(help === undefined ? {} : { fullDescription: help }),
            }) ?? alert)
          : alert,
      );
      const row = findRule(pane, target.key)?.rule;
      if (!row) throw new Error(`${target.key} is gone`);
      if (raw !== undefined) expect(row.title).toBe(raw);
      const told = Object.fromEntries(
        Object.entries(await outputs(sweep, target.key)).map(([name, text]) => [
          name,
          JSON.parse(text),
        ]),
      );
      const rows = (reading: { rules?: { rule: string; title: string }[] }) =>
        reading.rules?.filter(({ rule }) => rule === target.key) ?? [];
      const titles = [
        ...rows(told.place.reading),
        ...rows(told.campaign.reading),
        ...rows(told.fallback.reading),
        ...rows(told.tool),
      ].map(({ title }) => title);
      titles.push(
        told.rule.title,
        told.rule.reading.title,
        told.ruleTool.place,
        told.ruleTool.title,
      );
      expect(titles).toHaveLength(8);
      const title = raw === undefined ? row.title : sent ? journal.value(raw) : target.key;
      for (const each of titles) expect(each).toBe(title);
      const helps = [told.rule.reading, told.ruleTool].map(
        (reading: { facts: { label: string; words: string }[] }) =>
          reading.facts.find(({ label }) => label === "What it is")?.words,
      );
      const expected = help !== undefined && sent ? journal.value(help) : undefined;
      for (const each of helps) expect(each).toBe(expected);
      const stored = row.opened.help;
      if (help !== undefined && !sent && stored)
        for (const [name, value] of Object.entries(told))
          expect(JSON.stringify(value), name).not.toContain(JSON.stringify(stored).slice(1, -1));
    },
  );
  const pat = `github_pat_${"Qz".repeat(11)}`;
  const probes = {
    "a token split by zero-width spaces in the title": {
      alert: (alert: CodeAlertFact) =>
        parseCodeAlert({ ...alert, description: `${pat}\u200bQzFixture\u200bSensitiveSuffix` }),
      parts: ["QzFixture", "SensitiveSuffix", pat.slice(0, 16)],
    },
    "a YAML block with a password line in the help": {
      alert: (alert: CodeAlertFact) =>
        parseCodeAlert({ ...alert, fullDescription: "password: |\n  QzFixtureOnlyYamlPassword" }),
      parts: ["QzFixtureOnlyYamlPassword", "YamlPassword"],
    },
    "that help as an older collector saved it, flattened and unflagged": {
      alert: (alert: CodeAlertFact): CodeAlertFact => ({
        ...alert,
        fullDescription: "password: | QzFixtureOnlyYamlPassword",
      }),
      parts: ["QzFixtureOnlyYamlPassword", "YamlPassword"],
    },
  } as const;

  it.each(Object.keys(probes) as (keyof typeof probes)[])(
    "leaves no part of %s in anything Security tells Copilot",
    async (kind) => {
      const { alert: scanned, parts } = probes[kind];
      const { journal: known } = createToolOutputRedactor([`${pat}QzFixtureSensitiveSuffix`]);
      const { sweep } = scenario("1116", (alert) =>
        alert.rule === ruleId && alert.tool === tool_ ? (scanned(alert) ?? alert) : alert,
      );
      for (const [name, text] of Object.entries(await outputs(sweep, target.key, known)))
        for (const part of parts) expect(text, `${name}: ${part}`).not.toContain(part);
    },
  );
});

describe("a long scanner title outside Security", () => {
  const secret = "Qzfixture spaced-scanner-credential";
  const { journal } = createToolOutputRedactor([secret]);
  const raw = `${"w ".repeat(55)}${secret} tail of the title`;
  const told = `${"w ".repeat(55)}[redacted] tail of the title`;

  it("reaches the service, repository and alert routes whole, so redaction sees all of it", async () => {
    const input = fixtureInput();
    const data = input.facts.security.data ?? {};
    const [repo, alerts] =
      Object.entries(data).find(([name]) => name === "Azure/osdu-spi-partition") ?? [];
    const first = alerts?.code?.find(({ rule }) => rule === "java/spring-disabled-csrf-protection");
    if (!repo || !alerts?.code || !first) throw new Error("partition has no code alert");
    const parsed = parseCodeAlert({ ...first, description: raw });
    expect(parsed?.description).toBe(raw);
    expect(parsed).not.toHaveProperty("cut");
    alerts.code = alerts.code.map((alert) =>
      alert.rule === first.rule && alert.tool === first.tool
        ? { ...alert, description: parsed?.description ?? "" }
        : alert,
    );
    const view = projectWatch(input);
    const saved = {
      view,
      facts: input.facts,
      releases: { ...input.releases, records: input.releaseRecords },
      reads: { ...input.reads, releases: input.releaseRecords },
    };
    const latest = latestSweep(() => saved, { ctx: input.context, appData: input.appData });
    const alertLine = view.briefing.repositories.rows
      .flatMap(({ sections }) => sections.flatMap(({ lines }) => lines))
      .find(({ id, text }) => id?.startsWith("alert:") && text.includes("w w w"));
    if (!alertLine?.id) throw new Error("No alert line carries the title");
    const tools = spiToolProvider(spiReadTools(latest, journal)).offer();
    const session = new FakeSession({
      tools,
      availableTools: tools.map(({ name }) => `custom:${name}`),
      onPermissionRequest: buildPermissionGate(),
    });
    const call = async (name: string, args: object) => {
      const text = await session.callTool(name, args);
      if (typeof text !== "string") throw new Error(`${name} answered no text`);
      return JSON.parse(text);
    };
    const packed = async (id: string) => {
      const outcome = await chipFromSweep(latest, id, journal);
      if (!outcome.ok) throw new Error(`${id}: ${outcome.reason}`);
      return JSON.parse(outcome.chip.content);
    };
    const service = await packed("service:partition");
    const line = await call("spi_line", { service: "partition" });
    const repoChip = await packed("repo:partition");
    const inspectRepo = (await call("spi_inspect", { id: "repo:partition" })).item;
    const alertChip = await packed(alertLine.id);
    const inspectAlert = (await call("spi_inspect", { id: alertLine.id })).item;
    const labels = (reading: { items: { evidence: { label: string }[] }[] }) =>
      reading.items.flatMap(({ evidence }) => evidence.map(({ label }) => label));
    expect(labels(service.reading)).toContain(told);
    expect(labels(line.reading)).toContain(told);
    expect(line.home.overview.map(({ cause }: { cause: string }) => cause)).toEqual([told]);
    for (const item of [repoChip, inspectRepo]) {
      expect(item.title).toBe(`High code-scanning alert: ${told}`);
      expect(item.cause).toBe(item.title);
      expect(item.related[5].text).toBe(
        `${told} · 2 alerts · SPI · shipped · provider/partition-azure · found by CodeQL`,
      );
    }
    for (const item of [alertChip, inspectAlert]) {
      expect(item.title).toBe(`${told} · 2 alerts`);
      expect(item.cause).toBe(item.title);
      expect(item.related[0].text).toBe(item.title);
    }
    expect(alertLine.text).toContain(raw);
    for (const value of [service, line, repoChip, inspectRepo, alertChip, inspectAlert])
      expect(JSON.stringify(value)).not.toContain(secret.slice(0, secret.indexOf(" ")));
  });
});

describe("a scanner title of any length", () => {
  const titles = {
    unspaced: "安".repeat(10_000),
    spaced: "安全 ".repeat(3_400),
    "widest whole": "安".repeat(TITLE_MAX_CHARS),
  } as const;
  const told = (kind: keyof typeof titles, key: string) =>
    kind === "widest whole" ? titles[kind] : key;
  it.each(
    SECURITY_FIXTURES.flatMap((name) =>
      (Object.keys(titles) as (keyof typeof titles)[]).map((kind) => [name, kind] as const),
    ),
  )("keeps every %s chip and tool result within budget with a %s title", async (name, kind) => {
    const { pane, sweep } = scenario(name, (alert) =>
      withHelp(HELP.wide)(parseCodeAlert({ ...alert, description: titles[kind] }) ?? alert),
    );
    const place = await chip(sweep, "place:security");
    expect(Buffer.byteLength(place.content)).toBeLessThanOrEqual(SECURITY_CHIP_BYTE_BUDGET);
    expect(Buffer.byteLength((await tool(sweep)).text)).toBeLessThanOrEqual(SPI_RESULT_BYTE_BUDGET);
    for (const rule of rulesOf(pane)) {
      const one = await chip(sweep, `security-rule:${rule.key}`);
      expect(Buffer.byteLength(one.content), rule.key).toBeLessThanOrEqual(
        SECURITY_CHIP_BYTE_BUDGET,
      );
      expect(one.chip, rule.key).toHaveProperty("reading");
      expect(one.chip.title, rule.key).toBe(
        rule.key.includes(":code:") ? told(kind, rule.key) : rule.title,
      );
      const detail = await tool(sweep, { rule: rule.key });
      expect(Buffer.byteLength(detail.text), rule.key).toBeLessThanOrEqual(SPI_RESULT_BYTE_BUDGET);
      if (kind === "widest whole" && rule.key.includes(":code:")) {
        expect(rule, rule.key).not.toHaveProperty("cut");
        expect(detail.value.title, rule.key).toBe(titles[kind]);
        expect(detail.text, rule.key).toContain(HELP.wide);
      }
    }
  });

  it("bounds the tool's final bytes when a field no cap covers is over budget", async () => {
    const long = "r".repeat(20_000);
    const { pane, sweep } = scenario("1116", (alert) => ({ ...alert, rule: long }));
    const rule = rulesOf(pane).find(({ key }) => key.endsWith(long));
    if (!rule) throw new Error("No rule carries the long id");
    const tools = spiToolProvider(spiReadTools(() => sweep, journalOutputRedactor)).offer();
    const session = new FakeSession({
      tools,
      availableTools: tools.map(({ name }) => `custom:${name}`),
      onPermissionRequest: buildPermissionGate(),
    });
    const run = session.callTool("spi_security", { rule: rule.key });
    await expect(run).rejects.toThrow(`over ${SPI_RESULT_BYTE_BUDGET} UTF-8 bytes`);
    expect(Buffer.byteLength((await tool(sweep)).text)).toBeLessThanOrEqual(SPI_RESULT_BYTE_BUDGET);
  });
});

describe("a Security subject the latest sweep cannot show", () => {
  const { view, sweep } = scenario("1116");

  it("packs a closed rule as no open alert, and an unknown one in a partial sweep as possibly unread", async () => {
    const gone = await chip(sweep, "security-rule:spi:dep:closed-since");
    expect(gone.chip).toMatchObject({
      kind: "security rule",
      title: "spi:dep:closed-since",
      reading: { rule: "spi:dep:closed-since", open: "No open alert this sweep." },
      evidence: ["/security"],
    });
    const partial = scenario("partial");
    const unread = await chip(partial.sweep, "security-rule:spi:dep:closed-since");
    expect(unread.chip.reading).toMatchObject({
      open: "No open alert in the lists read this sweep; a list not read may still hold it.",
    });
  });

  it("finds a rule that moved lane in its lane now, and names the lanes when it is open in several", async () => {
    const { pane } = scenario("1116");
    const lanes = new Map(pane.lanes.map((lane) => [lane.id, lane.figure.label]));
    const rest = (key: string) => key.slice(key.indexOf(":"));
    const keys = rulesOf(pane).map(({ key }) => key);
    const lanesOf = (key: string) =>
      pane.lanes.filter(({ byRule }) => byRule.rules.some((rule) => rest(rule.key) === rest(key)));
    const moved = keys.find((key) => lanesOf(key).length === 1);
    const several = keys.find((key) => lanesOf(key).length === 2);
    if (!moved || !several) throw new Error("The 1116 scenario lacks a rule in one or two lanes");
    const away = (key: string) =>
      [...lanes.keys()].find((id) => !lanesOf(key).some((lane) => lane.id === id)) ?? "";
    const [now] = lanesOf(moved);
    const one = await chip(sweep, `security-rule:${away(moved)}${rest(moved)}`);
    expect(one.chip).toMatchObject({
      id: `security-rule:${away(moved)}${rest(moved)}`,
      kind: "security rule",
      reading: { rule: moved, lane: now?.id, moved: `Open in ${now?.figure.label} now.` },
      evidence: [findRule(pane, moved)?.at],
    });
    const detail = await tool(sweep, { rule: `${away(moved)}${rest(moved)}` });
    expect(detail.value).toMatchObject({ rule: moved, moved: `Open in ${now?.figure.label} now.` });
    const partial = scenario("partial");
    const lanesThere = partial.pane.lanes.filter(({ byRule }) =>
      byRule.rules.some((rule) => rest(rule.key) === rest(moved)),
    );
    if (lanesThere.length === 1 && lanesThere[0]?.id === now?.id)
      expect(
        (await chip(partial.sweep, `security-rule:${away(moved)}${rest(moved)}`)).chip.reading,
      ).toMatchObject({
        rule: moved,
        moved: `Open in ${now?.figure.label} now; a list not read may still hold it in ${lanes.get(away(moved) as never)}.`,
      });
    else throw new Error(`${moved} is not in one lane in the partial scenario`);
    const both = await chip(sweep, `security-rule:${away(several)}${rest(several)}`);
    const named = lanesOf(several).map(({ id }) => `${id}${rest(several)}`);
    expect(both.chip.reading).toEqual({
      rule: `${away(several)}${rest(several)}`,
      open: `No open alert in ${lanes.get(away(several) as never)} this sweep; open in ${lanesOf(
        several,
      )
        .map(({ figure }) => figure.label)
        .join(" and ")}.`,
      rules: named,
    });
    const partialLanes = (key: string) =>
      partial.pane.lanes.filter(({ byRule }) =>
        byRule.rules.some((rule) => rest(rule.key) === rest(key)),
      );
    const spread = rulesOf(partial.pane)
      .map(({ key }) => key)
      .find((key) => partialLanes(key).length === 2);
    if (!spread) throw new Error("The partial scenario lacks a rule in two lanes");
    const gone = [...lanes.keys()].find(
      (id) => !partialLanes(spread).some((lane) => lane.id === id),
    );
    const unread = await chip(partial.sweep, `security-rule:${gone}${rest(spread)}`);
    expect(unread.chip.reading).toEqual({
      rule: `${gone}${rest(spread)}`,
      open: `Open in ${partialLanes(spread)
        .map(({ figure }) => figure.label)
        .join(" and ")} now; a list not read may still hold it in ${lanes.get(gone as never)}.`,
      rules: partialLanes(spread).map(({ id }) => `${id}${rest(spread)}`),
    });
  });

  it("says not read with no pane, even beside a saved snapshot's old security reading", async () => {
    const { security: _, ...old } = view;
    const withReading: ViewSnapshot = {
      ...old,
      readings: [
        ...old.readings,
        {
          anchor: { kind: "security" },
          content: {
            headline: "1 high or critical finding needs SPI fixes.",
            tiles: [],
            items: [],
            groups: [],
          } as never,
        },
      ],
    };
    const bare: SavedSweep = { ...sweep, view: withReading };
    for (const id of ["place:security", "security-rule:spi:dep:anything"]) {
      const packed = await chip(bare, id);
      expect(packed.chip.reading).toBe("not read");
      expect(packed.content).not.toContain("SPI fixes");
    }
    expect((await tool(bare)).value).toMatchObject({ reading: "not read" });
  });

  it("resolves a subject saved from an old Security row through the inspector or the pane", async () => {
    const input = fixtureInput();
    const drawn = projectWatch(input);
    const pane = drawn.security;
    if (!pane) throw new Error("The 1106 snapshot has no pane");
    const tail = (key: string) => key.slice(key.indexOf(":code:") + ":code:".length);
    const lone = rulesOf(pane).find(
      ({ key }) =>
        key.includes(":code:") &&
        rulesOf(pane).filter((rule) => rule.key.endsWith(`:code:${tail(key)}`)).length === 1,
    );
    if (!lone) throw new Error("The 1106 snapshot has no code rule in one lane");
    const fact = tail(lone.key).replace(":", ": ");
    const projected: ViewSnapshot = {
      ...drawn,
      campaigns: [
        ...drawn.campaigns,
        {
          id: `campaign:security:${encodeURIComponent(fact)}`,
          kind: "security",
          fact,
          forks: ["legal", "storage"],
        },
      ],
    };
    const saved = {
      view: projected,
      facts: input.facts,
      releases: { ...input.releases, records: input.releaseRecords },
      reads: { ...input.reads, releases: input.releaseRecords },
    };
    const latest = latestSweep(() => saved, { ctx: input.context, appData: input.appData });
    const alert = projected.briefing.repositories.rows
      .flatMap(({ sections }) => sections.flatMap(({ lines }) => lines))
      .find(({ id }) => id?.startsWith("alert:"));
    if (!alert?.id) throw new Error("The 1106 snapshot has no alert line");
    expect(await chipFromSweep(latest, alert.id, journalOutputRedactor)).toMatchObject({
      ok: true,
      chip: { id: alert.id, chip: { id: alert.id, kind: "repository line", title: alert.text } },
    });
    const FROM = "The campaign row this was started from is no longer drawn.";
    const campaigns = projected.campaigns.filter(({ kind }) => kind === "security");
    expect(campaigns.length).toBeGreaterThan(1);
    const shapes = new Set<string>();
    for (const campaign of campaigns) {
      const matches = rulesOf(pane).filter(({ key }) =>
        key.endsWith(`:code:${campaign.fact.replace(": ", ":")}`),
      );
      const packed = await chipFromSweep(latest, campaign.id, journalOutputRedactor);
      if (!packed.ok) throw new Error(`${campaign.id}: ${packed.reason}`);
      const { chip: one } = packed.chip;
      expect(one.id).toBe(campaign.id);
      const [only] = matches;
      if (only && matches.length === 1) {
        shapes.add("rule");
        expect(one).toMatchObject({
          kind: "security rule",
          title: only.title,
          reading: { from: FROM, rule: only.key },
        });
      } else {
        shapes.add("place");
        expect(one).toMatchObject({
          kind: "place",
          title: "Security",
          reading: { from: FROM, open: matches.map(({ key }) => key) },
        });
      }
    }
    expect(shapes).toEqual(new Set(["rule", "place"]));
    expect(await chipFromSweep(latest, "campaign:security:gone", journalOutputRedactor)).toEqual({
      ok: false,
      reason: "Nothing in the latest sweep has the id campaign:security:gone.",
    });

    const without = {
      ...saved,
      view: { ...projected, campaigns: drawn.campaigns.filter(({ kind }) => kind !== "security") },
    };
    const later = latestSweep(() => without, { ctx: input.context, appData: input.appData });
    for (const campaign of campaigns) {
      const before = await chipFromSweep(latest, campaign.id, journalOutputRedactor);
      const after = await chipFromSweep(later, campaign.id, journalOutputRedactor);
      if (!before.ok || !after.ok)
        throw new Error(`${campaign.id}: ${after.ok ? "" : after.reason}`);
      expect(after.chip.chip, campaign.id).toEqual(before.chip.chip);
    }
    const closed = `campaign:security:${encodeURIComponent("Fixture: closed-since")}`;
    const fallback = await chipFromSweep(later, closed, journalOutputRedactor);
    expect(fallback).toMatchObject({
      ok: true,
      chip: {
        chip: { id: closed, kind: "place", title: "Security", reading: { from: FROM, open: [] } },
      },
    });
    for (const crafted of [
      "campaign:security:",
      "campaign:security:gone",
      "campaign:security:__proto__",
      "campaign:security:%E0%A4%A",
      `campaign:security:${encodeURIComponent("__proto__: constructor")}`,
      `campaign:security:${encodeURIComponent("CodeQL: ../../etc/passwd")}`,
      `campaign:security:${encodeURIComponent("CodeQL: java/x?y=1")}`,
      `campaign:security:${encodeURIComponent("CodeQL: java/log-injection").toLowerCase()}`,
      "campaign:security:CodeQL: java/log-injection",
      `campaign:security:${encodeURIComponent("Fixture\tScanner: java/log-injection")}`,
      `campaign:security:${encodeURIComponent("Fixture Scanner: java/log-injection")}`,
      `campaign:security:${encodeURIComponent("Fixture Scanner: java/log-injection")}`,
      `campaign:security:${encodeURIComponent(" Fixture Scanner: java/log-injection")}`,
      `campaign:security:${encodeURIComponent("Fixture Scanner : java/log-injection")}`,
      `campaign:security:${encodeURIComponent("Fixture  Scanner: java/log-injection")}`,
      `campaign:security:${encodeURIComponent("Fixture Scanner: java/log injection")}`,
      "campaign:security:Fixture+Scanner%3A%20java%2Flog-injection",
      "campaign:security:Fixture Scanner%3A%20java%2Flog-injection",
      `campaign:security:${encodeURIComponent("Fixture __proto__: java/log-injection")}`,
    ])
      expect(await chipFromSweep(later, crafted, journalOutputRedactor), crafted).toEqual({
        ok: false,
        reason: `Nothing in the latest sweep has the id ${crafted}.`,
      });
  });

  it("resolves the subject the producer saves for a scanner whose name has a space", async () => {
    const input = fixtureInput();
    for (const alerts of Object.values(input.facts.security.data ?? {}))
      if (alerts.code)
        alerts.code = alerts.code.map((alert) =>
          alert.rule === "java/log-injection" ? { ...alert, tool: "Fixture Scanner" } : alert,
        );
    const drawn = projectWatch(input);
    const campaign = drawn.campaigns.find(({ fact }) => fact.startsWith("Fixture Scanner: "));
    if (!campaign) throw new Error("The producer drew no campaign for Fixture Scanner");
    expect(campaign.id).toBe("campaign:security:Fixture%20Scanner%3A%20java%2Flog-injection");
    const pane = drawn.security;
    if (!pane) throw new Error("The 1106 snapshot has no pane");
    const matches = rulesOf(pane)
      .filter(({ key }) => key.endsWith(":code:Fixture Scanner:java/log-injection"))
      .map(({ key }) => key);
    expect(matches.length).toBeGreaterThan(0);
    const saved = (campaigns: ViewSnapshot["campaigns"]) => ({
      view: { ...drawn, campaigns },
      facts: input.facts,
      releases: { ...input.releases, records: input.releaseRecords },
      reads: { ...input.reads, releases: input.releaseRecords },
    });
    const ctx = { ctx: input.context, appData: input.appData };
    const current = latestSweep(() => saved(drawn.campaigns), ctx);
    const gone = latestSweep(
      () => saved(drawn.campaigns.filter(({ id }) => id !== campaign.id)),
      ctx,
    );
    const FROM = "The campaign row this was started from is no longer drawn.";
    for (const latest of [current, gone]) {
      const packed = await chipFromSweep(latest, campaign.id, journalOutputRedactor);
      if (!packed.ok) throw new Error(`${campaign.id}: ${packed.reason}`);
      expect(packed.chip.chip).toMatchObject(
        matches.length === 1
          ? { kind: "security rule", reading: { from: FROM, rule: matches[0] } }
          : { kind: "place", title: "Security", reading: { from: FROM, open: matches } },
      );
    }
  });
});
