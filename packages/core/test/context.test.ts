// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";
import { buildBriefing, readItem } from "../src/brief/index";
import { fleetOf } from "../src/config";
import { type CoreContext, contextFromEnv, createContext, defaultContext } from "../src/context";
import { buildModel } from "../src/model/index";
import { monthFacts } from "../src/model/releases";
import { cadence, toCrons } from "../src/model/schedule";
import { fixtureContext } from "./briefing-setup";
import releases from "./fixtures/rib-59d6895/releases.json";
import { FIXTURE_NOW, releasedFacts } from "./harness";

afterEach(() => vi.useRealTimers());

function briefing(context: CoreContext) {
  return buildBriefing(
    buildModel(releasedFacts(), undefined, {}, context),
    { state: "clear", problems: [] },
    undefined,
    context,
  );
}

describe("explicit core context", () => {
  test("interleaves two fleets, identities, lane overrides and rollout policies without interference", () => {
    const clock = { now: () => new Date(FIXTURE_NOW) };
    const a = createContext({
      ...fixtureContext,
      clock,
      rollout: { lanes: 2, ordering: [{ service: "file", after: ["legal", "schema"] }] },
    });
    const b = createContext({
      fleet: fleetOf([
        {
          id: "custom-partition",
          repo: "Azure/osdu-spi-partition",
          upstream: "custom/partition",
          mirror: true,
        },
        { id: "future", upstream: "custom/future" },
      ]),
      paths: {
        factsFile: "/b/facts.json",
        servicesFile: "/b/services.json",
        rolloutFile: "/b/rollout.json",
        lanesOverride: 1,
      },
      rollout: { lanes: 7 },
      clock,
    });
    const singleA = briefing(a);
    const singleB = briefing(b);
    expect(singleA).not.toEqual(singleB);
    for (const context of [b, a, b, a]) {
      expect(briefing(context)).toEqual(context === a ? singleA : singleB);
    }
    const ma = buildModel(releasedFacts(), undefined, {}, a);
    const mb = buildModel(releasedFacts(), undefined, {}, b);
    expect(ma.lines.map((l) => l.fork.id)).toEqual(fixtureContext.fleet.forks.map((f) => f.id));
    expect(mb.lines.map((l) => l.fork.id)).toEqual(["custom-partition"]);
    expect(mb.planned.map((s) => s.service.id)).toEqual(["future"]);
    expect(ma.lanes.cap).toBe(2);
    expect(mb.lanes).toMatchObject({ cap: 1, capFrom: "RIB_SPI_LANES" });
    expect(mb.repositories.rows.filter((r) => r.group === "fork").map((r) => r.name)).toEqual([
      "custom-partition",
    ]);
    expect(mb.work.forks.map((f) => f.name)).toEqual(["custom-partition"]);
    expect(monthFacts(releases, "2026-10", FIXTURE_NOW, b).services.total).toBe(1);
    expect(monthFacts(releases, "2026-10", FIXTURE_NOW, a).services.total).toBe(5);
  });

  test("briefing, reading and cadence follow two context clocks, not the ambient third clock", () => {
    const early = createContext({ ...fixtureContext, clock: { now: () => new Date(FIXTURE_NOW) } });
    const laterDate = new Date("2026-11-12T21:58:30Z");
    const late = createContext({ ...fixtureContext, clock: { now: () => new Date(laterDate) } });
    const expectedEarly = briefing(early);
    const expectedLate = briefing(late);
    expect(expectedEarly).not.toEqual(expectedLate);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2040-02-01T12:00:00Z"));
    expect(briefing(early)).toEqual(expectedEarly);
    expect(briefing(late)).toEqual(expectedLate);
    for (const context of [early, late]) {
      const date = context.clock.now();
      const model = buildModel(releasedFacts(), undefined, {}, context);
      expect(model).toEqual(buildModel(releasedFacts(), date, {}, context));
      const item = model.queue.items[0];
      if (!item) throw new Error("fixture has a queue item");
      expect(readItem(model, item, undefined, context)).toEqual(readItem(model, item, date));
      const crons = toCrons(["0 8 * * 1-5"]);
      expect(cadence(crons, "unscheduled", undefined, context)).toBe(
        cadence(crons, "unscheduled", date),
      );
    }
  });

  test("environment adapters snapshot paths and contexts detach mutable fleet and rollout inputs", () => {
    const env = {
      RIB_SPI_FACTS_FILE: "/a/facts.json",
      RIB_SPI_ROLLOUT_FILE: "/a/rollout.json",
      RIB_SPI_LANES: "3",
    };
    const context = contextFromEnv(env, { now: () => new Date(FIXTURE_NOW) });
    env.RIB_SPI_LANES = "9";
    expect(context.paths).toEqual({
      factsFile: "/a/facts.json",
      rolloutFile: "/a/rollout.json",
      servicesFile: undefined,
      lanesOverride: 3,
    });
    const ordering = [{ service: "file", after: ["legal"] }];
    const input = { ...fixtureContext, rollout: { lanes: 2, ordering } };
    const snapshot = createContext(input);
    ordering[0]?.after.push("schema");
    input.rollout.lanes = 9;
    expect(snapshot.rollout).toEqual({
      lanes: 2,
      ordering: [{ service: "file", after: ["legal"] }],
    });
    expect(Object.isFrozen(defaultContext)).toBe(true);
    expect(Object.isFrozen(defaultContext.fleet.services[0])).toBe(true);
    expect(Object.isFrozen(defaultContext.fleet.forks)).toBe(true);
  });
});
