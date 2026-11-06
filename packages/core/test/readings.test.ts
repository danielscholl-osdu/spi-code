// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildBriefing, type FocusItem } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { ReadRecord } from "../src/evidence/index.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { buildModel } from "../src/model/index.js";
import {
  internalNames,
  type PlaceReading,
  placeReading,
  type ReadingItem,
  readingText,
  readingWords,
  serviceReading,
  upstreamReading,
  wordCount,
} from "../src/readings/index.js";
import sweep from "./fixtures/upstream-1106.json";
import sweepReads from "./fixtures/upstream-1106-reads.json";

const previous = process.env.TZ;
process.env.TZ = "America/Chicago";
afterAll(() => {
  if (previous === undefined) delete process.env.TZ;
  else process.env.TZ = previous;
});

const context = createContext({
  fleet: fleetOf(
    builtInFleet(fileURLToPath(new URL("./fixtures/upstream-services.json", import.meta.url))),
  ),
});
const facts: Facts = { ...emptyFacts(), ...(structuredClone(sweep) as unknown as Partial<Facts>) };
const now = new Date(facts.sweep?.at ?? "");
const model = buildModel(facts, now, {}, context);
const briefing = buildBriefing(model, { state: "clear", problems: [] }, now, context);
const items: FocusItem[] = [...briefing.focus, ...briefing.rest];
const radar = sweepReads.radar as unknown as ReadRecord[];

const upstream = () => upstreamReading({ model, items, radar, fleet: context.fleet });
const service = (id: string) => serviceReading({ model, service: id, items, now });
const services = model.lines.map((line) => line.fork.id);

function clean(reading: PlaceReading<ReadingItem>): string[] {
  return readingText(reading).flatMap(internalNames);
}

describe("Upstream reading on the recorded 6 Nov sweep", () => {
  it("reads the next sync, commits incoming and forks reached", () => {
    const reading = upstream();
    expect(reading.headline).toBe("At 18:00, 107 commits reach 10 forks. Two need you first.");
    expect(wordCount(reading.headline)).toBeLessThanOrEqual(12);
    expect(reading.tiles[0]).toEqual({
      label: "Incoming",
      value: "107",
      counts: "commits · 10 of 13 forks",
    });
  });

  it("counts 8 forks moving to os-core-common 8.5.0", () => {
    expect(upstream().tiles[1]).toEqual({
      label: "Toolchain",
      value: "8 forks",
      counts: "move to os-core-common 8.5.0",
    });
  });

  it("leads with the two P1s that bite before the next sync", () => {
    const [first, second] = upstream().items;
    expect([first?.id, second?.id]).toEqual(["radar:partition", "radar:legal"]);
    for (const item of [first, second]) {
      expect(item).toMatchObject({ rung: 1, group: "Before 18:00" });
    }
  });

  it("names the largest forks by the commits they take", () => {
    expect(upstream().tiles[2]).toEqual({
      label: "Largest",
      value: "25",
      counts: "commits · indexer · then legal 17, schema 16",
    });
  });

  it("names the cut in plain words, and only when a read was cut", () => {
    expect(upstream().qualifier).toBe(
      "GitLab cut the upstream diffs for 6 services, so a toolchain move could be missing.",
    );
    const whole = radar.filter((record) => record.completeness.kind !== "cut");
    expect(
      upstreamReading({ model, items, radar: whole, fleet: context.fleet }),
    ).not.toHaveProperty("qualifier");
  });

  it("folds the rest into one line and shows no internal names", () => {
    const reading = upstream();
    expect(reading.items).toHaveLength(5);
    expect(reading.folded).toContain("5 more forks move to os-core-common 8.5.0");
    expect(clean(reading)).toEqual([]);
  });
});

describe("Service readings on the recorded 6 Nov sweep", () => {
  it("keeps every service within five items, a 12-word headline and no internal names", () => {
    expect(services).toHaveLength(13);
    for (const id of services) {
      const reading = service(id);
      if (!reading) throw new Error(`no reading for ${id}`);
      expect(reading.items.length, id).toBeLessThanOrEqual(5);
      expect(wordCount(reading.headline), id).toBeLessThanOrEqual(12);
      expect(clean(reading), id).toEqual([]);
      expect(readingText(reading).join(" "), id).not.toMatch(/upstream MRs/i);
    }
  });

  it("reads entitlements in about 120 words with a release review", () => {
    const reading = service("entitlements");
    if (!reading) throw new Error("no entitlements reading");
    expect(reading.headline).toBe("Cascade stopped on a merge conflict.");
    expect(reading.tiles.map((tile) => tile.label)).toEqual(["Upstream", "Line", "Release review"]);
    expect(reading.items[0]).toMatchObject({ rung: 0, group: "Stopped" });
    expect(readingWords(reading)).toBeGreaterThanOrEqual(80);
    expect(readingWords(reading)).toBeLessThanOrEqual(150);
  });

  it("groups items by their projected due time when attention carries one", () => {
    const storage = items.filter((item) => item.scope === "storage" && item.rung === 1);
    const target = storage.find((item) => !item.id.startsWith("radar:"));
    if (!target) throw new Error("no storage decision");
    const due = { at: "2026-11-06T20:30:00.000Z", before: "release" };
    const reading = serviceReading({
      model,
      service: "storage",
      items: items.map((item) => (item === target ? { ...item, due } : item)),
      now,
    });
    expect(reading?.items[0]).toMatchObject({ id: target.id, group: "Before 14:30" });
  });

  it("returns null for a service the sweep has no line for", () => {
    expect(service("nowhere")).toBeNull();
  });
});

describe("placeReading", () => {
  const item = (n: number): ReadingItem => ({
    id: `i${n}`,
    ids: [`i${n}`],
    rung: 2,
    cls: "READY",
    scope: `s${n}`,
    title: `Title ${n}`,
    sub: "",
  });
  const tile = { label: "L", value: "V", counts: "things" };

  it("drops repeats, caps at five items and folds the rest into one line", () => {
    const reading = placeReading({
      headline: "H",
      tiles: [tile, tile, tile],
      groups: [
        { group: "A", items: [item(1), item(2), item(1)] },
        { group: "B", items: [item(3), item(4), item(5), item(6), item(7)] },
      ],
      extra: "Extra.",
    });
    expect(reading.items.map((i) => [i.id, i.group])).toEqual([
      ["i1", "A"],
      ["i2", "A"],
      ["i3", "B"],
      ["i4", "B"],
      ["i5", "B"],
    ]);
    expect(reading.folded).toBe("2 more items: s6 title 6, s7 title 7. Extra.");
    expect(reading).not.toHaveProperty("qualifier");
  });

  it("leaves nothing folded when everything fits", () => {
    expect(
      placeReading({
        headline: "H",
        tiles: [tile, tile, tile],
        groups: [{ group: "A", items: [item(1)] }],
      }).folded,
    ).toBeNull();
  });

  it("catches each internal name the window keeps in Detail", () => {
    expect(internalNames("fork_upstream ahead")).toEqual(["fork_upstream"]);
    expect(internalNames("gate 3 · PR #9")).toEqual(["gate N"]);
    expect(internalNames("two presses left")).toEqual(["presses"]);
    expect(internalNames("cut: 6 services")).toEqual(["cut as a label"]);
    expect(internalNames("GitLab cut the upstream diffs")).toEqual([]);
  });
});
