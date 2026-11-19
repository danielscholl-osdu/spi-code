// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import type { JsonValue, ToolOutputRedactor } from "@spi-code/threads";
import { describe, expect, it } from "vitest";
import { detailFeedPath, recordedSnapshotPath } from "../../../test/watch/snapshot-fixture.js";
import { CHIP_TOKEN_BUDGET, type PackedChip, packChip, TRIMMED_CHIP_KEEPS } from "./chip.js";
import { addChip, chipFromSweep, MAX_CHIPS, refreshChip, snapshotChips } from "./draft.js";
import type { SavedSweep } from "./sweep.js";
import { estimateTokens } from "./tokens.js";

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
    expect(chip.tokens).toBeLessThanOrEqual(CHIP_TOKEN_BUDGET);
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
    const partition = result("radar:partition");
    const whole = {
      ...partition,
      evidence: partition.evidence.slice(0, 12),
    };
    expect(estimateTokens(JSON.stringify(whole))).toBeGreaterThan(CHIP_TOKEN_BUDGET);
    const outcome = packChip({ kind: "queue item", result: whole }, at, plain);
    if (!outcome.ok) throw new Error(outcome.reason);
    const chip = outcome.chip;
    expect(chip.trimmed).toBe(true);
    expect(chip.tokens).toBeLessThanOrEqual(CHIP_TOKEN_BUDGET);
    expect(Object.keys(chip.chip)).toEqual([...TRIMMED_CHIP_KEEPS, "trimmed"]);
    expect(chip.chip.trimmed).toMatch(/left out effect, why, related, areas;/);
    expect(chip.chip.evidence).toHaveLength(whole.evidence.length);
    expect(chip.chip.evidence).toContain(
      "Azure/osdu-spi-entitlements .github/upstream-filter.yml (failed)",
    );
    expect(chip.chip.notRead).toEqual(expect.arrayContaining(["approvals", "security"]));
    expect(chip.chip).toMatchObject({ cause: whole.cause, next: whole.next, class: whole.class });
  });

  it("refuses a chip whose kept set is still over budget, and never clips its text", () => {
    const outcome = packChip({ kind: "queue item", result: result("radar:partition") }, at, plain);
    expect(outcome).toEqual({
      ok: false,
      reason: `radar:partition is over ${CHIP_TOKEN_BUDGET} tokens even trimmed to identity, class, cause, next and evidence references.`,
    });
  });

  it("says when each retained read was first read", () => {
    const [first, ...rest] = result("radar:partition").evidence;
    if (!first) throw new Error("Fixture radar:partition has no evidence");
    const kept = { ...first, retainedFrom: "2026-11-05T09:00:00.000Z" };
    const evidence = [kept, ...rest.slice(0, 3)];
    const outcome = packChip(
      { kind: "queue item", result: { ...result("radar:partition"), evidence } },
      at,
      plain,
    );
    expect(outcome.ok && outcome.chip.chip.evidence).toContain(
      `${first.source} ${first.object} (failed) (retained from 2026-11-05T09:00:00.000Z)`,
    );
  });

  it("is what the model redactor returned", () => {
    const upper = (value: JsonValue): JsonValue =>
      typeof value === "string"
        ? value.toUpperCase()
        : Array.isArray(value)
          ? value.map(upper)
          : value !== null && typeof value === "object"
            ? Object.fromEntries(Object.entries(value).map(([key, field]) => [key, upper(field)]))
            : value;
    const chip = pack("rollout", { value: upper });
    expect(chip.chip.cause).toBe(result("rollout").cause.toUpperCase());
    expect(chip.content).toBe(JSON.stringify(chip.chip));
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
    if (legal.chip.trimmed) expect(legal.chip.chip.trimmed).toMatch(/left out reading, areas;/);
    else expect(legal.chip.chip.reading).toEqual(whole?.content);
  });

  it("packs Security's own reading as not read, and refuses Environment and Program", async () => {
    const security = await chipFromSweep(() => sweepAt(view.sweptAt), "place:security", plain);
    if (!security.ok) throw new Error(security.reason);
    expect(security.chip.chip).toMatchObject({
      kind: "place",
      title: "Security",
      completeness: "partial",
      notRead: ["security"],
      reading: view.readings.find(({ anchor }) => anchor.kind === "security")?.content,
      areas: [{ area: "security", state: "unread" }],
    });
    for (const id of ["place:environment", "place:program"]) {
      expect(await chipFromSweep(() => sweepAt(view.sweptAt), id, plain)).toEqual({
        ok: false,
        reason: `${id} cannot be a chip yet: it packs with the scope that reads it.`,
      });
    }
  });
});

describe("the token estimate", () => {
  // cl100k_base and o200k_base each count 1,201 tokens in these 1,202 bytes.
  const dense = JSON.stringify(
    Array.from({ length: 600 }, (_, i) => `${i % 10}${"!#%&*+-/<=>?@^|~"[(i * 7) % 16]}`).join(""),
  );

  it("is at least the reference encodings' count on dense input", () => {
    expect(Buffer.byteLength(dense)).toBe(1202);
    expect(estimateTokens(dense)).toBeGreaterThanOrEqual(1201);
  });

  it("bounds every fixture chip, whole and trimmed, by its UTF-8 bytes", () => {
    for (const entry of feed) {
      for (const budget of [() => 0, (text: string) => (JSON.parse(text).trimmed ? 0 : Infinity)]) {
        const outcome = packChip({ kind: "queue item", result: entry }, at, plain, budget);
        if (!outcome.ok) throw new Error(outcome.reason);
        const { content } = outcome.chip;
        expect(estimateTokens(content)).toBeGreaterThanOrEqual(Buffer.byteLength(content));
      }
    }
  });
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
