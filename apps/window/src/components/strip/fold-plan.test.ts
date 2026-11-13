// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  CAPTION_BUTTONS,
  DRAG_AREA,
  type FieldWidths,
  type FoldChange,
  type FoldPlan,
  planFold,
  STRIP_FIELDS,
} from "./fold-plan.js";

const GAP = 14;
const TOGGLES = 80;
const GEOMETRY = {
  macOS: { lead: 16 + 74 + GAP, trail: GAP + TOGGLES + 10 },
  Windows: { lead: 14, trail: GAP + TOGGLES + GAP + CAPTION_BUTTONS },
} as const;
type Platform = keyof typeof GEOMETRY;

const width = (platform: Platform, window: number) => ({
  first: window - GEOMETRY[platform].lead - GEOMETRY[platform].trail,
  second: window - 26,
});

// "Environment Ready", "Templates 13 pending", "Forks 1 stopped"; 20 services widen the counts.
const fields = (services: number, environment = { full: 131, short: 82 }): FieldWidths => ({
  environment,
  template: services > 13 ? 136 : 130,
  forks: services > 13 ? 111 : 105,
  nextSync: 108,
  freshness: 78,
});
/** "Environment Maintenance · refresh running" and its "Env" form. */
const LONG_ENVIRONMENT = { full: 280, short: 230 };

function plan(
  platform: Platform,
  window: number,
  content: FieldWidths,
  change: FoldChange = "resize",
  previous?: FoldPlan,
) {
  return planFold({ fields: content, width: width(platform, window), gap: GAP, change, previous });
}

const folds = ({ level, environment, first, second, height }: FoldPlan) => ({
  level,
  environment,
  first,
  second,
  height,
});

describe("PS-18 order at every width", () => {
  const trailing = ["nextSync", "freshness"];
  const cases: [Platform, number, number, number, string[]][] = [
    ["macOS", 1440, 13, 0, []],
    ["macOS", 1100, 13, 0, []],
    ["macOS", 980, 13, 0, []],
    ["macOS", 740, 13, 2, trailing],
    ["macOS", 1440, 20, 0, []],
    ["macOS", 1100, 20, 0, []],
    ["macOS", 980, 20, 0, []],
    ["macOS", 740, 20, 2, trailing],
    ["Windows", 1440, 13, 0, []],
    ["Windows", 1100, 13, 0, []],
    ["Windows", 980, 13, 0, []],
    ["Windows", 740, 13, 2, trailing],
    ["Windows", 1440, 20, 0, []],
    ["Windows", 1100, 20, 0, []],
    ["Windows", 980, 20, 0, []],
    ["Windows", 740, 20, 2, trailing],
  ];

  it.each(cases)(
    "%s at %i px with %i services folds to level %i",
    (platform, window, services, level, second) => {
      const next = plan(platform, window, fields(services));
      expect(next.level).toBe(level);
      expect([...next.first, ...next.second]).toEqual(STRIP_FIELDS);
      expect(next.second).toEqual(second);
      expect(next.environment).toBe("full");
      expect(next.free).toBeGreaterThanOrEqual(DRAG_AREA);
      expect(next.height).toBe(second.length > 0 ? 75 : 44);
      expect(next.fits).toBe(true);
    },
  );

  it.each([
    ["macOS", 13],
    ["macOS", 20],
    ["Windows", 13],
    ["Windows", 20],
  ] as const)(
    "%s at 740 px with %i services shortens a long environment state to Env, then wraps Forks after next sync and freshness",
    (platform, services) => {
      const next = plan(platform, 740, fields(services, LONG_ENVIRONMENT));
      expect(next.first).toEqual(["environment", "template"]);
      expect(next.second).toEqual(["forks", "nextSync", "freshness"]);
      expect(next).toMatchObject({ level: 4, environment: "short", fits: true, height: 75 });
      expect(next.free).toBeGreaterThanOrEqual(DRAG_AREA);
    },
  );

  it("wraps next sync and freshness, then shortens Environment, then wraps Forks, Templates and Environment in turn", () => {
    const at = (first: number) =>
      planFold({
        fields: fields(13, LONG_ENVIRONMENT),
        width: { first, second: 1000 },
        gap: GAP,
        change: "resize",
      });
    const steps = [820, 600, 560, 500, 300, 200].map((first) => {
      const { level, environment, first: row, second } = at(first);
      return { level, environment, row, second };
    });
    expect(steps).toEqual([
      { level: 0, environment: "full", row: STRIP_FIELDS, second: [] },
      {
        level: 2,
        environment: "full",
        row: ["environment", "template", "forks"],
        second: ["nextSync", "freshness"],
      },
      {
        level: 3,
        environment: "short",
        row: ["environment", "template", "forks"],
        second: ["nextSync", "freshness"],
      },
      {
        level: 4,
        environment: "short",
        row: ["environment", "template"],
        second: ["forks", "nextSync", "freshness"],
      },
      {
        level: 5,
        environment: "short",
        row: ["environment"],
        second: ["template", "forks", "nextSync", "freshness"],
      },
      { level: 6, environment: "short", row: [], second: STRIP_FIELDS },
    ]);
  });

  it("keeps the PS-18 order when fields are absent", () => {
    const { nextSync: _nextSync, ...content } = fields(13);
    const next = plan("macOS", 740, content);
    expect(next.first).toEqual(["environment", "template", "forks"]);
    expect(next.second).toEqual(["freshness"]);
  });

  it("never wraps the second row again, and says so when it is short", () => {
    const next = planFold({
      fields: fields(20, LONG_ENVIRONMENT),
      width: { first: 60, second: 400 },
      gap: GAP,
      change: "resize",
    });
    expect(next.first).toEqual([]);
    expect(next.second).toEqual(STRIP_FIELDS);
    expect(next).toMatchObject({ level: 6, height: 75, fits: false });
  });
});

describe("hysteresis", () => {
  const shrunk = (): FieldWidths => ({
    environment: { full: 90, short: 60 },
    template: 80,
    forks: 70,
    nextSync: 100,
    freshness: 44,
  });

  it("keeps the previous plan when a content change shrinks the fields", () => {
    const previous = plan("macOS", 700, fields(13));
    expect(previous.second).toEqual(["nextSync", "freshness"]);
    const next = plan("macOS", 700, shrunk(), "content", previous);
    expect(folds(next)).toEqual(folds(previous));
    expect(plan("macOS", 700, shrunk()).second).toEqual([]);
  });

  it("folds and wraps at once when a content change grows the fields", () => {
    const previous = plan("macOS", 980, fields(13));
    expect(previous.level).toBe(0);
    const next = plan("macOS", 980, fields(13, { full: 300, short: 250 }), "content", previous);
    expect(next.level).toBe(2);
    expect(next.height).toBe(75);
  });

  it("folds at once when the window narrows", () => {
    const previous = plan("macOS", 1440, fields(13));
    expect(previous.level).toBe(0);
    expect(plan("macOS", 740, fields(13), "resize", previous).level).toBe(2);
  });

  it.each(["resize", "sweep"] as const)("unwraps on a %s with 24 px of slack, not 23", (change) => {
    const previous = plan("macOS", 740, fields(13));
    expect(previous.level).toBe(2);
    const needs = 608 + DRAG_AREA + GEOMETRY.macOS.lead + GEOMETRY.macOS.trail;
    expect(plan("macOS", needs, fields(13)).level).toBe(0);
    expect(plan("macOS", needs - 1, fields(13)).level).toBe(2);

    const tight = plan("macOS", needs + 23, fields(13), change, previous);
    expect(folds(tight)).toEqual(folds(previous));

    const roomy = plan("macOS", needs + 24, fields(13), change, previous);
    expect(roomy).toMatchObject({ level: 0, second: [], height: 44 });
    expect(roomy.free).toBe(DRAG_AREA + 24);
  });

  it("restores the Environment label only with 24 px of slack", () => {
    const content = fields(13, LONG_ENVIRONMENT);
    const at = (first: number, change: FoldChange, previous?: FoldPlan) =>
      planFold({ fields: content, width: { first, second: 1000 }, gap: GAP, change, previous });
    const full = LONG_ENVIRONMENT.full + 130 + 105 + 2 * GAP + DRAG_AREA;
    const previous = at(full - 1, "resize");
    expect(previous).toMatchObject({ level: 3, environment: "short" });
    expect(at(full + 23, "resize", previous).environment).toBe("short");
    expect(at(full + 24, "resize", previous)).toMatchObject({ level: 2, environment: "full" });
    expect(at(full + 200, "content", previous).environment).toBe("short");
  });
});
