// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { detailFeedPath, recordedSnapshotPath } from "../../../test/watch/snapshot-fixture.js";
import { CHIP_TOKEN_BUDGET, type PackedChip, packChip, TRIMMED_CHIP_KEEPS } from "./chip.js";
import { addChip, chipFromSweep, MAX_CHIPS, refreshChip, snapshotChips } from "./draft.js";
import type { JsonValue, ModelRedactor } from "./seams.js";
import type { SavedSweep } from "./sweep.js";
import { estimateTokens } from "./tokens.js";

const view: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));
const feed: InspectResult[] = JSON.parse(readFileSync(detailFeedPath, "utf8"));
const plain: ModelRedactor = { text: (text) => text, value: (value) => value };
const result = (id: string) => {
  const found = feed.find((entry) => entry.id === id);
  if (!found) throw new Error(`Fixture has no ${id}`);
  return found;
};
const sweepAt = (sweptAt: string): SavedSweep => ({
  view: { ...view, sweptAt },
  inspect: async (id) => {
    const found = feed.find((entry) => entry.id === id);
    return found && { kind: "queue item", result: found };
  },
});
const pack = (id: string, redactor = plain) => {
  const outcome = packChip({ kind: "queue item", result: result(id) }, view.sweptAt, redactor);
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
    expect(chip.chip.notRead).toEqual([
      "approvals",
      "security",
      "radar failed; retained earlier read",
    ]);
  });

  it("trims an over-budget chip to PS-14's kept set, in its order, and says so", () => {
    const whole = result("radar:partition");
    expect(estimateTokens(JSON.stringify(whole))).toBeGreaterThan(CHIP_TOKEN_BUDGET);
    const chip = pack("radar:partition");
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
    const long = { ...result("rollout"), cause: "a cause ".repeat(800) };
    const outcome = packChip({ kind: "queue item", result: long }, view.sweptAt, plain);
    expect(outcome).toEqual({
      ok: false,
      reason: `rollout is over ${CHIP_TOKEN_BUDGET} tokens even trimmed to identity, class, cause, next and evidence references.`,
    });
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
    const chip = pack("rollout", { text: (text) => text, value: upper });
    expect(chip.chip.cause).toBe(result("rollout").cause.toUpperCase());
    expect(chip.content).toBe(JSON.stringify(chip.chip));
  });
});

describe("a draft's chips", () => {
  const ids = feed.slice(0, MAX_CHIPS + 1).map(({ id }) => id);

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
