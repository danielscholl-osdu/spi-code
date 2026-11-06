// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { afterAll, describe, expect, test, vi } from "vitest";
import { upstreamView } from "../../src/brief/upstream.js";
import { builtInFleet, fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { inspectUpstreamPlan } from "../../src/inspect/upstream-plan.js";
import { buildModel } from "../../src/model/index.js";
import { parseRollout } from "../../src/rollout.js";
import { RIB_VOICE } from "../../src/voice.js";
import { UPSTREAM_NOW, UPSTREAM_SERVICES, UPSTREAM_STATES } from "../upstream-states.js";

vi.stubEnv("TZ", "UTC");
afterAll(() => vi.unstubAllEnvs());

const hashes: Record<string, string> = {
  "plan-ready": "a64747bc11c073f4e54449c755acb5affb3e766debfccad0d8264d87c3e7b715",
  "pilot-cascade": "ff399d1bb11800c8e6367080e9b3215dcc29f599a4a9ac4972c5a2e2082d18ba",
  "wave-gates": "d5a2372c172014a79e7a2d804ecf703ed7a7e4b122e31470a2403c7bb6e44bec",
  "fork-stopped": "6822a44e26c8773a28ee839fc9c3ceef10defd3bcd562c6bd1bf85a278e28067",
  "same-cause": "4c08cc86012685f6e44837bdf79e0737d389a0b315d6fbde7e76e32fe9a322b2",
  "env-held": "38d87a3bf582aed348af4e8edff4d2621a1c791224122fbd820df48f3db0c185",
};
const cases = Object.entries(UPSTREAM_STATES).map(([name, build]) => {
  const facts = build();
  const context = createContext({
    fleet: fleetOf(builtInFleet(UPSTREAM_SERVICES)),
    rollout: parseRollout(facts.fleet.data?.rollout as string).rollout,
    clock: { now: () => UPSTREAM_NOW },
  });
  const model = buildModel(facts, UPSTREAM_NOW, {}, context);
  return { name, model, board: inspectUpstreamPlan(model, UPSTREAM_NOW, { voice: RIB_VOICE }) };
});

describe("pinned rib upstream-plan parity", () => {
  test.each(cases)(
    "$name matches the whole rib board from identical recorded Facts",
    ({ name, board }) => {
      expect(createHash("sha256").update(JSON.stringify(board)).digest("hex")).toBe(hashes[name]);
      expect(board.sections.some((section) => section.title === "Schedule")).toBe(true);
      expect(board.sections.some((section) => section.title === "Lanes")).toBe(true);
      expect(board.sections.some((section) => section.title === "Waves")).toBe(true);
      expect(board.header.status.label).toBe(
        name === "same-cause" ? "UPSTREAM PLAN PAUSED" : "UPSTREAM PLAN",
      );
    },
  );

  test("by default the plan and Flow name SPI Code where the rib named itself", () => {
    const text = cases
      .flatMap(({ model }) => [
        JSON.stringify(inspectUpstreamPlan(model, UPSTREAM_NOW)),
        JSON.stringify(upstreamView(model.upstream, UPSTREAM_NOW)),
      ])
      .join("\n");
    expect(text).not.toMatch(/\b[Rr]ib\b/);
    for (const said of [
      "you · SPI Code",
      "SPI Code dispatches the cascade at once",
      "Start · SPI Code",
      "in SPI Code · ",
    ])
      expect(text).toContain(said);
  });

  test("the fork table follows Flow, with one-word pills and no plan column", () => {
    const scenario = cases.find(({ name }) => name === "wave-gates");
    if (!scenario) throw new Error("Missing wave fixture");
    const table = scenario.board.sections.find(
      (section) => section.kind === "table" && section.title.startsWith("Forks"),
    );
    if (table?.kind !== "table") throw new Error("Missing fork table");
    const flow = upstreamView(scenario.model.upstream, UPSTREAM_NOW);
    expect(
      table.rows.map((row) => (typeof row.fork === "object" ? row.fork.value : row.fork)),
    ).toEqual(flow.rows.map((row) => row.fork));
    for (const row of table.rows) {
      expect(row.plan).toBeUndefined();
      for (const key of ["sync", "cascade", "toMain", "main"]) {
        const cell = row[key];
        expect(typeof cell === "object" ? (cell.badges?.[0]?.text ?? "·") : cell).not.toContain(
          " ",
        );
      }
    }
    expect(flow.rows.find((row) => row.fork === "file")?.line[0]?.text).toBe("ready");
  });
});
