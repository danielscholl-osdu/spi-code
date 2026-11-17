// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { buildBriefing } from "../src/brief/index";
import { todayLines } from "../src/brief/lines";
import { itemEvidence } from "../src/inspect/item-evidence";
import { CLASS_VERB } from "../src/model/next";
import {
  sweep1116Context as context,
  SWEEP_1116_NOW as now,
  sweep1116Items,
  sweep1116Model,
} from "./sweep-1116";

const model = sweep1116Model();
const items = sweep1116Items(model);
const lines = todayLines(model, items, now, context);
const lineWith = (id: string) => lines.find((line) => line.members.some((m) => m.id === id));

describe("Today's situation lines", () => {
  test("the unchanged 16 Nov sweep has 10 lines and 18 members: 2 blocked, 16 waiting", () => {
    expect(lines).toHaveLength(10);
    expect(lines.flatMap((line) => line.members)).toHaveLength(18);
    expect(
      lines.filter((line) => line.section === "blocked").flatMap((l) => l.members),
    ).toHaveLength(2);
    expect(
      lines.filter((line) => line.section === "waiting").flatMap((l) => l.members),
    ).toHaveLength(16);
  });

  test("five red PRs take their blocker's move and keep the lane condition before the merge", () => {
    const line = lineWith("gate2:legal");
    expect(line?.members.map((m) => m.fork)).toEqual([
      "indexer-queue",
      "legal",
      "entitlements",
      "schema",
      "indexer",
    ]);
    expect(line).toMatchObject({
      subject: "5 forks",
      headline: "release/upstream PR red: its deploy lane failed",
      steps: [
        "Re-run the failed lanes once the others drain.",
        "Approve and merge each PR once it is green.",
      ],
    });
    expect(line?.deadline).toBeUndefined();
    const member = line?.members.find((m) => m.fork === "legal");
    expect(member?.primary).toMatchObject({
      kind: "pr",
      url: "https://github.com/Azure/osdu-spi-legal/pull/90",
    });
    expect(member?.evidence).toEqual(itemEvidence(model, ["gate2:legal", "stack:lanes"]));
    expect(member?.evidence.notRead).toContain("Whether the other lanes have drained");
    expect(lines.flatMap((l) => l.members).some((m) => m.id === "stack:lanes")).toBe(false);
  });

  test("four sync PR objects each hold upgrade then review, dated by the PR", () => {
    const line = lineWith("gate1:unit");
    expect(line?.members.map((m) => m.fork)).toEqual(["unit", "workflow", "crs-catalog", "search"]);
    expect(line).toMatchObject({
      subject: "4 forks",
      headline: "sync PR needs os-core-common upgraded on the fork first",
      age: "10d",
      steps: ["Upgrade os-core-common in the fork's pom.xml.", "Review and merge the sync PR."],
    });
    expect(line?.members[0]).toMatchObject({
      id: "gate1:unit",
      ids: ["radar:unit", "gate1:unit"],
      age: "10d",
      primary: { kind: "pr", url: "https://github.com/Azure/osdu-spi-unit/pull/50" },
    });
    expect(line?.members[0]?.steps[0]).toContain("8.5.0");
  });

  test("different failures stay separate even when both moves are Investigate", () => {
    expect(lineWith("gate2:storage")).toMatchObject({
      subject: "storage",
      headline: "release/upstream PR fails Validation Summary",
    });
    expect(lineWith("lane-deploy:partition")).toMatchObject({
      subject: "partition",
      headline: "lane deploy failed",
    });
    expect(lineWith("gate2:storage")).not.toBe(lineWith("lane-deploy:partition"));
  });

  test("approval members do not claim green while a member's checks are running", () => {
    const group = lineWith("gate2:partition");
    expect(group?.members.map((m) => m.id)).toEqual(["gate2:search", "gate2:partition"]);
    expect(group?.headline).toBe("release/upstream PR waits for approval");
  });

  test("no line headline leaks a core verb name or error code", () => {
    const verbs = [...new Set([...Object.values(CLASS_VERB), ...items.map((i) => i.verb)])];
    for (const line of lines) {
      for (const verb of verbs) expect(line.headline).not.toContain(verb);
      expect(line.headline).not.toMatch(/\b[A-Z]+(?:_[A-Z]+)+\b/);
    }
  });

  test("undated objects sort last, and a wholly undated line has no age", () => {
    const changed = structuredClone(model);
    const unit = changed.queue.items.find((q) => q.id === "gate1:unit");
    if (!unit) throw new Error("unit PR is in the sweep");
    delete unit.since;
    const result = todayLines(changed, items, now, context);
    const group = result.find((l) => l.members.some((m) => m.id === unit.id));
    expect(group?.members.at(-1)).toMatchObject({ id: unit.id });
    expect(group?.members.at(-1)?.age).toBeUndefined();
    for (const q of changed.queue.items) delete q.since;
    const undated = todayLines(changed, items, now, context);
    expect(
      undated.every((l) => l.age === undefined && l.members.every((m) => m.age === undefined)),
    ).toBe(true);
  });

  test("the next actor decides inclusion, Can wait stays out, unknown blockers claim no move", () => {
    const sample = items.find((i) => i.id === "gate1:crs-conversion");
    if (!sample) throw new Error("sample PR is in the sweep");
    expect(todayLines(model, [{ ...sample, actor: "system" }], now, context)).toEqual([]);
    expect(todayLines(model, [{ ...sample, actor: undefined }], now, context)).toEqual([]);
    expect(todayLines(model, [{ ...sample, attention: "background" }], now, context)).toEqual([]);
    expect(todayLines(model, [{ ...sample, blockedBy: "missing" }], now, context)).toEqual([]);
    const blocker = { ...sample, id: "blocker", subject: undefined, actor: "system" as const };
    expect(
      todayLines(model, [blocker, { ...sample, blockedBy: blocker.id }], now, context),
    ).toEqual([]);
    expect(todayLines(model, [{ ...sample, rung: 2 }], now, context)).toHaveLength(1);
    const red = items.find((i) => i.id === "gate2:legal");
    const lanes = items.find((i) => i.id === "stack:lanes");
    if (!red || !lanes) throw new Error("red PR and its lanes blocker are in the sweep");
    const blocked = todayLines(model, [{ ...red, actor: "system" }, lanes], now, context);
    expect(blocked.flatMap((line) => line.members.map((member) => member.id))).toEqual([red.id]);
  });

  test("deadlines name the scheduled reason; conditions never pretend to be a date", () => {
    expect(lineWith("halt:crs-conversion")?.deadline).toMatchObject({
      at: "2026-11-18T00:00:00.000Z",
      reason: expect.stringContaining("Before the next upstream sync"),
    });
    expect(lineWith("rollout")).toMatchObject({
      subject: "7 forks",
      headline: "template 1a4730d not synced yet",
      deadline: {
        at: "2026-11-17T08:00:00.000Z",
        reason: expect.stringContaining("all 7 PRs at once"),
      },
    });
  });

  test("adding situation lines leaves the default core briefing byte-identical", () => {
    const brief = () => buildBriefing(model, { state: "clear", problems: [] }, now, context);
    const original = JSON.stringify(brief());
    todayLines(model, items, now, context);
    expect(JSON.stringify(brief())).toBe(original);
    expect(brief()).not.toHaveProperty("lines");
  });
});
