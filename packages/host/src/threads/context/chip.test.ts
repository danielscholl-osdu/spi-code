// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { journalOutputRedactor, type ToolOutputRedactor } from "@spi-code/threads";
import { describe, expect, it } from "vitest";
import { detailFeedPath, recordedSnapshotPath } from "../../../test/watch/snapshot-fixture.js";
import { CHIP_BYTE_BUDGET, type PackedChip, packChip, TRIMMED_CHIP_KEEPS } from "./chip.js";
import { addChip, chipFromSweep, MAX_CHIPS, refreshChip, snapshotChips } from "./draft.js";
import { packFinding } from "./finding.js";
import { PLACES } from "./places.js";
import { wordsText } from "./security.js";
import type { SavedSweep } from "./sweep.js";

const view: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));
const feed: InspectResult[] = JSON.parse(readFileSync(detailFeedPath, "utf8"));
const plain: Pick<ToolOutputRedactor, "value"> = { value: (value) => value };
const result = (id: string) => {
  const found = feed.find((entry) => entry.id === id);
  if (!found) throw new Error(`Fixture has no ${id}`);
  return found;
};
const sweepAt = (sweptAt: string): SavedSweep => ({
  view: { ...view, sweptAt },
  reads: {},
  inspect: async (id) => {
    const found = feed.find((entry) => entry.id === id);
    return found && { kind: "queue item", result: found };
  },
});
const at = { sweptAt: view.sweptAt, reads: {} };
const pack = (id: string, redactor = plain) => {
  const outcome = packChip({ kind: "queue item", result: result(id) }, at, redactor);
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.chip;
};

describe("a context chip", () => {
  it("packs an inspect answer whole when it fits, with its sweep time and what was not read", () => {
    const chip = pack("conflict:entitlements:121");
    expect(chip.trimmed).toBe(false);
    expect(chip.bytes).toBeLessThanOrEqual(CHIP_BYTE_BUDGET);
    expect(chip.content).toBe(JSON.stringify(chip.chip));
    expect(chip.chip).toMatchObject({
      id: "conflict:entitlements:121",
      kind: "queue item",
      sweptAt: view.sweptAt,
      completeness: "partial",
      effect: result("conflict:entitlements:121").effect,
      why: result("conflict:entitlements:121").why,
    });
    expect(chip.chip.notRead).toEqual(["approvals", "security", "radar failed this sweep"]);
  });

  it("trims an over-budget chip to PS-14's kept set, in its order, and says so", () => {
    const whole = result("radar:partition");
    const chip = pack("radar:partition");
    expect(chip.trimmed).toBe(true);
    expect(chip.bytes).toBeLessThanOrEqual(CHIP_BYTE_BUDGET);
    expect(Object.keys(chip.chip)).toEqual([...TRIMMED_CHIP_KEEPS, "trimmed"]);
    expect(chip.chip.trimmed).toMatch(/left out effect, why, related, areas.*spi_inspect/);
    expect(chip.chip.evidence).toHaveLength(whole.evidence.length);
    expect(chip.chip.evidence).toContain(
      "Azure/osdu-spi-entitlements .github/upstream-filter.yml (failed)",
    );
    expect(chip.chip.notRead).toEqual(expect.arrayContaining(["approvals", "security"]));
    expect(chip.chip).toMatchObject({ cause: whole.cause, next: whole.next, class: whole.class });
  });

  it("keeps the evidence references that fit in UTF-8 bytes and counts those left out", () => {
    const partition = result("radar:partition");
    const record = partition.evidence[0];
    if (!record) throw new Error("Fixture radar:partition has no evidence");
    const evidence = Array.from({ length: 30 }, (_, i) => ({
      ...record,
      object: `${i} ${"🌍".repeat(500)}`,
    }));
    const outcome = packChip({ kind: "queue item", result: { ...partition, evidence } }, at, plain);
    if (!outcome.ok) throw new Error(outcome.reason);
    const { chip, content, bytes } = outcome.chip;
    expect(chip.trimmed).toMatch(/spi_inspect/);
    expect(chip.evidenceLeftOut).toEqual(28);
    expect(chip.evidence).toEqual(
      evidence.slice(0, 2).map(({ source, object }) => `${source} ${object} (failed)`),
    );
    expect(bytes).toEqual(Buffer.byteLength(content));
    expect(bytes).toBeLessThanOrEqual(CHIP_BYTE_BUDGET);
    expect(
      Buffer.byteLength(content) + Buffer.byteLength(JSON.stringify(evidence[2]?.object)),
    ).toBeGreaterThan(CHIP_BYTE_BUDGET);
  });

  it("keeps the whole reference list when it fills the budget without an omission count", () => {
    const rollout = result("rollout");
    const evidence = ["a", "b"].map((object) => ({
      source: "s",
      object,
      observedAt: at.sweptAt,
      completeness: { kind: "complete" as const },
    }));
    const packWithCause = (cause: string) =>
      packChip(
        { kind: "queue item", result: { ...rollout, evidence, cause, why: "a".repeat(6000) } },
        at,
        plain,
      );
    const short = packWithCause("");
    if (!short.ok) throw new Error(short.reason);
    const exact = packWithCause("a".repeat(CHIP_BYTE_BUDGET - short.chip.bytes));
    if (!exact.ok) throw new Error(exact.reason);
    expect(exact.chip.bytes).toBe(CHIP_BYTE_BUDGET);
    expect(exact.chip.chip.evidence).toEqual(["s a", "s b"]);
    expect(exact.chip.chip.evidenceLeftOut).toBeUndefined();
  });

  it("says when each retained read was first read", () => {
    const [first, ...rest] = result("radar:partition").evidence;
    if (!first) throw new Error("Fixture radar:partition has no evidence");
    const kept = { ...first, retainedFrom: "2026-11-05T09:00:00.000Z" };
    const evidence = [kept, ...rest];
    const outcome = packChip(
      { kind: "queue item", result: { ...result("radar:partition"), evidence } },
      at,
      plain,
    );
    expect(outcome.ok && outcome.chip.chip.evidence).toContain(
      `${first.source} ${first.object} (failed) (retained from 2026-11-05T09:00:00.000Z)`,
    );
  });

  it("withholds the chip when its value cannot be redacted", () => {
    const outcome = packChip({ kind: "queue item", result: result("rollout") }, at, {
      value: () => {
        throw new Error("fixture-private-value");
      },
    });
    expect(outcome).toEqual({ ok: false, reason: "Context chip withheld." });
  });
});

describe("a place chip", () => {
  it("packs a service's own reading, not its upstream fork, and keeps the scope out of it", async () => {
    const legal = await chipFromSweep(() => sweepAt(view.sweptAt), "service:legal", plain);
    if (!legal.ok) throw new Error(legal.reason);
    const index = view.services?.findIndex(({ service }) => service === "legal");
    expect(legal.chip.chip).toMatchObject({
      id: "service:legal",
      kind: "place",
      title: "Service legal",
      sweptAt: view.sweptAt,
      evidence: [`/services/${index}/home`],
    });
    expect(legal.chip.chip).not.toHaveProperty("class");
    const whole = view.readings.find(
      ({ anchor }) => anchor.kind === "service" && anchor.id === "legal",
    );
    expect(legal.chip.chip.reading).toEqual(whole?.content);
  });

  it("packs Security from its pane as not read, and Environment and Program as theirs", async () => {
    const security = await chipFromSweep(() => sweepAt(view.sweptAt), "place:security", plain);
    if (!security.ok) throw new Error(security.reason);
    expect(view.security?.read).toBe(false);
    expect(security.chip.chip).toMatchObject({
      kind: "place",
      title: "Security",
      completeness: "partial",
      reading: {
        headline: "Security not read.",
        banner: wordsText(view.security?.page.banner ?? []),
      },
      areas: [{ area: "security", state: "unread" }],
      evidence: ["/security"],
    });
    expect(security.chip.chip.notRead).toEqual([
      "security",
      ...(view.security?.unread ?? []).map(
        ({ repository }) => `Dependabot and code scanning alerts in ${repository}`,
      ),
    ]);
    for (const [id, title, anchor] of [
      ["place:environment", "Environment", "environment"],
      ["place:program", "Today", "program"],
    ] as const) {
      const packed = await chipFromSweep(() => sweepAt(view.sweptAt), id, plain);
      if (!packed.ok) throw new Error(packed.reason);
      expect(packed.chip.chip).toMatchObject({ id, kind: "place", title });
      const content = view.readings.find((reading) => reading.anchor.kind === anchor)?.content;
      expect(packed.chip.chip.reading).toEqual(content);
    }
  });
});

it("packs all 54 recorded chips within 6,000 UTF-8 bytes, trimming only two", async () => {
  const ids = [
    ...feed.map(({ id }) => id),
    ...Object.keys(PLACES),
    ...(view.services ?? []).map(({ service }) => `service:${service}`),
  ];
  const trimmed: string[] = [];
  for (const id of ids) {
    const outcome = await chipFromSweep(() => sweepAt(view.sweptAt), id, journalOutputRedactor);
    if (!outcome.ok) throw new Error(`${id}: ${outcome.reason}`);
    const { bytes, content, chip } = outcome.chip;
    expect(bytes).toBe(Buffer.byteLength(content));
    expect(bytes).toBeLessThanOrEqual(6000);
    if (outcome.chip.trimmed) {
      trimmed.push(id);
      expect(chip.trimmed).toMatch(id === "place:upstream" ? /spi_radar/ : /spi_inspect/);
    }
  }
  expect(ids).toHaveLength(54);
  expect(trimmed).toEqual(["radar:partition", "place:upstream"]);
});

describe("a draft's chips", () => {
  const ids = feed
    .filter((entry) => packChip({ kind: "queue item", result: entry }, at, plain).ok)
    .slice(0, MAX_CHIPS + 1)
    .map(({ id }) => id);

  it("refuses a ninth chip and replaces a chip already on the draft", () => {
    let chips: readonly PackedChip[] = [];
    for (const id of ids.slice(0, MAX_CHIPS)) {
      const added = addChip(chips, pack(id));
      if (!added.ok) throw new Error(added.reason);
      chips = added.chips;
    }
    const ninth = ids[MAX_CHIPS] ?? "";
    expect(addChip(chips, pack(ninth))).toEqual({
      ok: false,
      reason: "A message carries at most 8 context chips.",
    });
    const again = addChip(chips, pack(ids[2] ?? ""));
    expect(again.ok && again.chips.map(({ id }) => id)).toEqual(ids.slice(0, MAX_CHIPS));
    expect(snapshotChips([...chips, pack(ninth)])).toMatchObject({ ok: false });
  });

  it("refreshes from the latest sweep with its time, while a sent message keeps its payload", async () => {
    let latest = sweepAt(view.sweptAt);
    const first = await chipFromSweep(() => latest, "rollout", plain);
    if (!first.ok) throw new Error(first.reason);
    const sent = snapshotChips([first.chip]);
    if (!sent.ok) throw new Error(sent.reason);
    expect(sent.attachments).toEqual([{ name: "context:rollout", content: first.chip.content }]);

    latest = sweepAt("2026-11-07T08:00:00.000Z");
    const refreshed = await refreshChip(() => latest, first.chip, plain);
    expect(refreshed.ok && refreshed.chip.sweptAt).toBe("2026-11-07T08:00:00.000Z");
    expect(refreshed.ok && refreshed.chip.chip.sweptAt).toBe("2026-11-07T08:00:00.000Z");
    expect(JSON.parse(sent.attachments[0]?.content ?? "").sweptAt).toBe(view.sweptAt);
  });

  it("packs nothing without a saved sweep or for an id the latest sweep lacks", async () => {
    expect(await chipFromSweep(() => undefined, "rollout", plain)).toEqual({
      ok: false,
      reason: "No sweep has been saved.",
    });
    expect(await chipFromSweep(() => sweepAt(view.sweptAt), "nope", plain)).toEqual({
      ok: false,
      reason: "Nothing in the latest sweep has the id nope.",
    });
  });
});

describe("a finding chip", () => {
  const answered = (text: string) =>
    ({
      read: () => ({
        thread: { scope: "program", title: "Forks on 8.4" },
        turns: [{ id: "u1", outcome: "completed", text }],
      }),
      eventsSince: () => [{ type: "turn.finished", turnId: "u1", at: Date.UTC(2026, 10, 16) }],
    }) as unknown as Parameters<typeof packFinding>[0];

  it("cuts an over-budget multibyte answer to a prefix measured in serialized UTF-8 bytes", () => {
    const opening = "Search and legal pin 8.4. ";
    const outcome = packFinding(answered(opening + "🙂".repeat(4000)), "finding:p1", plain);
    if (!outcome.ok) throw new Error(outcome.reason);
    const { finding } = outcome.chip.chip;
    if (typeof finding !== "string") throw new Error("No finding");
    expect(outcome.chip.trimmed).toBe(true);
    expect(finding.startsWith(`${opening}🙂`)).toBe(true);
    expect(finding.endsWith("🙂…")).toBe(true);
    expect(Buffer.from(finding).toString()).toBe(finding);
    expect(outcome.chip.bytes).toBe(Buffer.byteLength(outcome.chip.content));
    expect(outcome.chip.bytes).toBeLessThanOrEqual(CHIP_BYTE_BUDGET);
    expect(outcome.chip.bytes).toBeGreaterThan(CHIP_BYTE_BUDGET - 4);
  });
});
