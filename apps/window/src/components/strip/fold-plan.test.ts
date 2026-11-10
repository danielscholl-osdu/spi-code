// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  CAPTION_BUTTONS,
  DRAG_AREA,
  type FieldWidths,
  type FoldChange,
  type FoldPlan,
  pipsWidth,
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

const fields = (services: number, environment = 158): FieldWidths => ({
  pips: { full: pipsWidth(services, "full"), small: pipsWidth(services, "small") },
  stopped: { names: 216, count: 66 },
  environment: { full: environment, version: 80 },
  template: 101,
  nextSync: 108,
  freshness: 78,
});
const LONG_ENVIRONMENT = 500;

function plan(
  platform: Platform,
  window: number,
  content: FieldWidths,
  change: FoldChange = "resize",
  previous?: FoldPlan,
) {
  return planFold({ fields: content, width: width(platform, window), gap: GAP, change, previous });
}

const folds = ({ level, shorten, first, second, height }: FoldPlan) => ({
  level,
  shorten,
  first,
  second,
  height,
});

describe("PS-18 order at every width", () => {
  const trailing = ["nextSync", "freshness"];
  const cases: [Platform, number, number, number, string[]][] = [
    ["macOS", 1440, 13, 0, []],
    ["macOS", 1100, 13, 1, []],
    ["macOS", 980, 13, 2, []],
    ["macOS", 740, 13, 3, trailing],
    ["macOS", 1440, 20, 0, []],
    ["macOS", 1100, 20, 1, []],
    ["macOS", 980, 20, 3, trailing],
    ["macOS", 740, 20, 4, ["template", ...trailing]],
    ["Windows", 1440, 13, 0, []],
    ["Windows", 1100, 13, 1, []],
    ["Windows", 980, 13, 3, trailing],
    ["Windows", 740, 13, 4, ["template", ...trailing]],
    ["Windows", 1440, 20, 0, []],
    ["Windows", 1100, 20, 2, []],
    ["Windows", 980, 20, 3, trailing],
    ["Windows", 740, 20, 4, ["template", ...trailing]],
  ];

  it.each(cases)(
    "%s at %i px with %i services folds to level %i",
    (platform, window, services, level, second) => {
      const next = plan(platform, window, fields(services));
      expect(next.level).toBe(level);
      expect([...next.first, ...next.second]).toEqual(["pips", ...STRIP_FIELDS]);
      expect(next.second).toEqual(second);
      expect(next.first[0]).toBe("pips");
      expect(next.free).toBeGreaterThanOrEqual(DRAG_AREA);
      expect(next.height).toBe(second.length > 0 ? 75 : 44);
      expect(next.fits).toBe(true);
    },
  );

  it("shrinks stopped names before the pips, and both before anything wraps", () => {
    expect(plan("macOS", 980, fields(13))).toMatchObject({
      stopped: "count",
      pips: "small",
      second: [],
    });
    expect(plan("macOS", 1100, fields(13))).toMatchObject({
      stopped: "count",
      pips: "full",
      second: [],
    });
  });

  it.each([
    ["macOS", 13],
    ["macOS", 20],
    ["Windows", 13],
    ["Windows", 20],
  ] as const)(
    "%s at 740 px with %i services wraps a long environment state and drops it to its version",
    (platform, services) => {
      const next = plan(platform, 740, fields(services, LONG_ENVIRONMENT));
      expect(next.first).toEqual(["pips", "stopped"]);
      expect(next.second).toEqual(["environment", "template", "nextSync", "freshness"]);
      expect(next).toMatchObject({ environment: "version", fits: true, height: 75 });
      expect(next.free).toBeGreaterThanOrEqual(DRAG_AREA);
    },
  );

  it("never wraps the second row again when shortening the environment", () => {
    const next = planFold({
      fields: fields(20, LONG_ENVIRONMENT),
      width: { first: 220, second: 560 },
      gap: GAP,
      change: "resize",
    });
    expect(next.first).toEqual(["pips"]);
    expect(next.second).toEqual(STRIP_FIELDS);
    expect(next).toMatchObject({ environment: "version", height: 75, fits: true });
  });

  it("keeps the PS-18 order when fields are absent", () => {
    const { stopped: _stopped, template: _template, ...content } = fields(13);
    const next = plan("macOS", 740, content);
    expect(next.first).toEqual(["pips", "environment"]);
    expect(next.second).toEqual(["nextSync", "freshness"]);
  });
});

describe("hysteresis", () => {
  const shrunk = (): FieldWidths => ({
    ...fields(13),
    stopped: { names: 110, count: 66 },
    environment: { full: 90, version: 80 },
    freshness: 44,
  });

  it("keeps the previous plan when a content change shrinks the fields", () => {
    const previous = plan("macOS", 900, fields(13));
    expect(previous.second).toEqual(["nextSync", "freshness"]);
    const next = plan("macOS", 900, shrunk(), "content", previous);
    expect(folds(next)).toEqual(folds(previous));
    expect(plan("macOS", 900, shrunk()).second).toEqual([]);
  });

  it("folds and wraps at once when a content change grows the fields", () => {
    const previous = plan("macOS", 980, fields(13));
    expect(previous.level).toBe(2);
    const next = plan("macOS", 980, fields(13, 360), "content", previous);
    expect(next.level).toBe(3);
    expect(next.height).toBe(75);
  });

  it("folds at once when the window narrows", () => {
    const previous = plan("macOS", 1440, fields(13));
    expect(previous.level).toBe(0);
    expect(plan("macOS", 980, fields(13), "resize", previous).level).toBe(2);
  });

  it.each(["resize", "sweep"] as const)("unwraps on a %s with 24 px of slack, not 23", (change) => {
    const previous = plan("macOS", 900, fields(13));
    expect(previous.level).toBe(3);
    const needs = 683 + DRAG_AREA + GEOMETRY.macOS.lead + GEOMETRY.macOS.trail;
    expect(plan("macOS", needs, fields(13)).level).toBe(2);

    const tight = plan("macOS", needs + 23, fields(13), change, previous);
    expect(folds(tight)).toEqual(folds(previous));

    const roomy = plan("macOS", needs + 24, fields(13), change, previous);
    expect(roomy).toMatchObject({ level: 2, second: [], height: 44 });
    expect(roomy.free).toBe(DRAG_AREA + 24);
  });

  it("restores the environment's full state only with 24 px of slack on the second row", () => {
    const content = fields(20, LONG_ENVIRONMENT);
    const at = (second: number, change: FoldChange, previous?: FoldPlan) =>
      planFold({ fields: content, width: { first: 220, second }, gap: GAP, change, previous });
    const full = LONG_ENVIRONMENT + 66 + 101 + 108 + 78 + 4 * GAP;
    const previous = at(full - 1, "resize");
    expect(previous.environment).toBe("version");
    expect(at(full + 23, "resize", previous).environment).toBe("version");
    expect(at(full + 24, "resize", previous).environment).toBe("full");
    expect(at(full + 200, "content", previous).environment).toBe("version");
  });
});
