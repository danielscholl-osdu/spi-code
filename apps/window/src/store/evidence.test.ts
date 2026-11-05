// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { areaEnvelope, envelopesFor, isInferred } from "./evidence.js";

const mixed = ViewSnapshotSchema.parse(
  JSON.parse(readFileSync(resolve("fixtures/watch/snapshot-mixed-59d6895.json"), "utf8")),
);

const deployability = "/briefing/environment/facts/1/figure";
const maintenance = "/briefing/environment/lanes/3";
const blockedLane = "/stations/0/stations/5";

describe("evidence helpers on the mixed-source fixture", () => {
  it("marks lifecycle-only deployability and maintenance values inferred", () => {
    expect(mixed.briefing.environment.facts[1]?.label).toMatch(/^Deployable/);
    expect(mixed.briefing.environment.lanes[3]?.id).toBe("holds");
    expect(isInferred(mixed, deployability)).toBe(true);
    expect(isInferred(mixed, maintenance)).toBe(true);
  });

  it("marks a station inferred when only lifecycle fed its branch", () => {
    expect(mixed.stations[0]?.stations[5]).toMatchObject({
      id: "lane",
      text: "blocked by the stack",
    });
    expect(isInferred(mixed, blockedLane)).toBe(true);
  });

  it("leaves observed peers and values without provenance uninferred", () => {
    expect(isInferred(mixed, "/briefing/facts/1/figure")).toBe(false);
    expect(isInferred(mixed, "/briefing/flow/rows/0")).toBe(false);
    expect(isInferred(mixed, "/stations/0/stations/4")).toBe(false);
    expect(isInferred(mixed, "/briefing/headline")).toBe(false);
    expect(isInferred(mixed, "/briefing/environment")).toBe(false);
    expect(isInferred(mixed, `${deployability}/x`)).toBe(false);
  });

  it("reads an area's envelope", () => {
    expect(areaEnvelope(mixed, "lifecycle")).toMatchObject({ source: "lifecycle", inferred: true });
    expect(areaEnvelope(mixed, "github")).toMatchObject({ source: "github", inferred: false });
    expect(areaEnvelope(mixed, "fleet")).toEqual({ source: "fleet", state: "unread" });
  });

  it("returns the envelopes of the areas feeding values under a prefix", () => {
    const names = (prefix: string) => envelopesFor(mixed, prefix).map(({ area }) => area);
    expect(names(deployability)).toEqual(["lifecycle"]);
    expect(envelopesFor(mixed, maintenance)).toEqual([
      { area: "lifecycle", envelope: areaEnvelope(mixed, "lifecycle") },
    ]);
    expect(names("/briefing/environment/lanes")).toEqual(["lifecycle"]);
    expect(names("/briefing/flow/rows/0/next")).toEqual([
      "github",
      "runs",
      "lifecycle",
      "upstream",
      "radar",
    ]);
    expect(names("/briefing/environment")).toEqual(["github", "lifecycle"]);
    expect(names("/briefing/facts")).toEqual([
      "github",
      "runs",
      "lifecycle",
      "details",
      "template",
    ]);
    expect(names("/briefing/repositories/rows/0/cells/issues")).toEqual([
      "github",
      "radar",
      "template",
      "security",
    ]);
    expect(names("/briefing/flow/row")).toEqual([]);
    expect(names("/briefing/head")).toEqual([]);
  });
});
