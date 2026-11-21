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

/** Help as long as a sweep keeps it, in one-byte and three-byte characters, and five CWEs. */
const HELP = {
  none: "",
  ascii: `${"Untrusted input reaches a sink without being checked first, so a caller can change what the call does. ".repeat(3).slice(0, 299).trimEnd()}…`,
  wide: "安全".repeat(150),
} as const;
const CWES = ["cwe-079", "cwe-116", "cwe-020", "cwe-1333", "cwe-400"];
const withHelp =
  (help: string) =>
  (alert: CodeAlertFact): CodeAlertFact =>
    help
      ? {
          ...alert,
          fullDescription: help,
          tags: ["security", ...CWES.map((id) => `external/cwe/${id}`)],
        }
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
  const { pane, sweep } = scenario("1116", (alert) => ({
    ...alert,
    description: `Hard-coded ${hub} in config`,
    fullDescription: `Rotate ${known} before release.`,
  }));
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
    expect(texts[0]).toContain(`${lead.trimEnd()}…`);
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

describe("a scanner title of any length", () => {
  const titles = {
    unspaced: "安".repeat(10_000),
    spaced: "安全 ".repeat(3_400),
  } as const;
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
      expect(one.chip.title, rule.key).toBe(rule.title);
      const detail = await tool(sweep, { rule: rule.key });
      expect(Buffer.byteLength(detail.text), rule.key).toBeLessThanOrEqual(SPI_RESULT_BYTE_BUDGET);
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
  });
});
