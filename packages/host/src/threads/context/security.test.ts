// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { InspectResult, SecurityPane, ViewSnapshot } from "@spi-code/contracts";
import { createToolOutputRedactor, journalOutputRedactor } from "@spi-code/threads";
import { describe, expect, it } from "vitest";
import {
  SECURITY_FIXTURES,
  type SecurityFixture,
  securitySweep,
} from "../../../test/watch/security-fixture.js";
import { detailFeedPath, recordedSnapshotPath } from "../../../test/watch/snapshot-fixture.js";
import { FakeSession } from "../../testing/fake-session.js";
import { buildPermissionGate } from "../../tools/permission-gate.js";
import { SPI_RESULT_BYTE_BUDGET, spiReadTools, spiToolProvider } from "../../tools/spi-reads.js";
import { areaEnvelopes } from "../../watch/provenance.js";
import { chipFromSweep } from "./draft.js";
import { readPlace } from "./places.js";
import type { SpiRedactor } from "./redaction.js";
import { findRule, SECURITY_CHIP_BYTE_BUDGET, wordsText } from "./security.js";
import type { SavedSweep } from "./sweep.js";

const recorded: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));

/** The recorded snapshot carrying a scenario's pane, with the security area its records give. */
function scenario(name: SecurityFixture, edit: (pane: SecurityPane) => SecurityPane = (p) => p) {
  const { pane, records, now } = securitySweep(name);
  const security = areaEnvelopes({ security: records }, () => 3_600_000, now).find(
    ({ area }) => area === "security",
  );
  const view: ViewSnapshot = {
    ...recorded,
    security: edit(pane),
    areas: recorded.areas.map((entry) =>
      entry.area === "security" && security ? security : entry,
    ),
  };
  const sweep: SavedSweep = { view, reads: { security: records }, inspect: async () => undefined };
  return { pane: edit(pane), view, sweep };
}

async function chip(sweep: SavedSweep, id: string, redactor: SpiRedactor = journalOutputRedactor) {
  const outcome = await chipFromSweep(() => sweep, id, redactor);
  if (!outcome.ok) throw new Error(`${id}: ${outcome.reason}`);
  return outcome.chip;
}

async function tool(sweep: SavedSweep, args: object = {}, redactor = journalOutputRedactor) {
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

  it("packs every rule's chip within 2,000 UTF-8 bytes", async () => {
    for (const rule of rulesOf(pane)) {
      const one = await chip(sweep, `security-rule:${rule.key}`);
      expect(one.bytes, rule.key).toBeLessThanOrEqual(SECURITY_CHIP_BYTE_BUDGET);
      if (one.trimmed) expect(one.chip.reading, rule.key).toHaveProperty("leftOut");
      expect(one.chip.evidence, rule.key).toEqual([findRule(pane, rule.key)?.at]);
    }
  });

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
  const dirty = (pane: SecurityPane): SecurityPane => {
    const copy = structuredClone(pane);
    const lane = copy.lanes[0];
    const rule = lane?.byRule.rules[0];
    if (!rule) throw new Error("The single scenario has no rule");
    rule.title = `Hard-coded ${hub}`;
    rule.opened.help = `Rotate ${known} before release.`;
    for (const line of rule.opened.where) line.files = [{ code: `src/${known}/Config.java` }];
    return copy;
  };

  it("passes the redactor before it reaches Copilot, in the chips and the tool", async () => {
    const { pane, sweep } = scenario("single", dirty);
    const key = rulesOf(pane)[0]?.key ?? "";
    const texts = [
      (await chip(sweep, "place:security", journal)).content,
      (await chip(sweep, `security-rule:${key}`, journal)).content,
      (await tool(sweep, {}, journal)).text,
      (await tool(sweep, { rule: key }, journal)).text,
    ];
    for (const text of texts) {
      expect(text).not.toContain(hub);
      expect(text).not.toContain(known);
      expect(text).toContain("[redacted]");
    }
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

  it("sends a subject saved from an old Security row to the inspector, which reads no reading", async () => {
    const asked: string[] = [];
    const feed: InspectResult[] = JSON.parse(readFileSync(detailFeedPath, "utf8"));
    const sample = feed[0] as InspectResult;
    const inspecting: SavedSweep = {
      ...sweep,
      inspect: async (id) => {
        asked.push(id);
        return { kind: "queue item", result: { ...sample, id } };
      },
    };
    const old = ["alert:osdu-spi-storage:dependabot:12", "campaign:cve:CVE-2026-0001"];
    for (const id of old) {
      expect(readPlace(view, id)).toBeUndefined();
      expect(await chipFromSweep(() => inspecting, id, journalOutputRedactor)).toMatchObject({
        ok: true,
        chip: { id, chip: { id, kind: "queue item", title: sample.title } },
      });
    }
    expect(asked).toEqual(old);
  });
});
