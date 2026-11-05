// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Envelope, ViewSnapshotSchema } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { areaEnvelope, envelopesFor, envelopesForAll, isInferred } from "./evidence.js";

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

it("unions the envelopes under several prefixes in area order, without repeats", () => {
  const names = (prefixes: string[]) => envelopesForAll(mixed, prefixes).map(({ area }) => area);
  expect(names(["/briefing/environment/lanes", "/briefing/flow/tiles/0"])).toEqual([
    "lifecycle",
    "upstream",
  ]);
  expect(
    names(["/briefing/flow/tiles/0", "/briefing/flow/tiles/3", "/stations/0/stations/0"]),
  ).toEqual(["github", "runs", "upstream"]);
  expect(names([])).toEqual([]);
  expect(names(["/releases"])).toEqual(["fleet"]);
});

it.each<{ envelope: Envelope | undefined; inferred: boolean }>([
  { envelope: undefined, inferred: true },
  {
    envelope: {
      source: "releases",
      state: "fresh",
      observedAt: mixed.sweptAt,
      completeness: { kind: "complete" },
      inferred: true,
    },
    inferred: true,
  },
  {
    envelope: {
      source: "releases",
      state: "fresh",
      observedAt: mixed.sweptAt,
      completeness: { kind: "complete" },
      inferred: false,
    },
    inferred: false,
  },
  {
    envelope: {
      source: "releases",
      state: "failed",
      completeness: { kind: "complete" },
    },
    inferred: false,
  },
  { envelope: { source: "releases", state: "unread" }, inferred: false },
])(
  "requires every area and a present supplemental envelope to be inferred: $envelope",
  ({ envelope, inferred }) => {
    const pointer = "/releases/lines/0";
    const source = {
      path: pointer,
      areas: ["lifecycle"] as const,
      ...(envelope ? { envelope } : {}),
    };
    const evidence = {
      areas: mixed.areas,
      provenance: [{ ...source, areas: [...source.areas] }],
    };
    expect(isInferred(evidence, pointer)).toBe(inferred);
    expect(
      isInferred(
        { ...evidence, provenance: [{ ...source, areas: ["lifecycle", "github"] }] },
        pointer,
      ),
    ).toBe(false);
    expect(isInferred(evidence, "/releases/lines")).toBe(false);
    expect(isInferred(evidence, `${pointer}/headline`)).toBe(false);
  },
);
