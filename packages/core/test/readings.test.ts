// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildBriefing, type FocusItem } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { ReadRecord } from "../src/evidence/index.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { detectCampaigns } from "../src/model/campaigns.js";
import { buildModel } from "../src/model/index.js";
import {
  internalNames,
  NOT_READ,
  type PlaceReading,
  placeReading,
  type ReadingCampaign,
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

const upstream = (campaigns: readonly ReadingCampaign[] = []) =>
  upstreamReading({ model, items, radar, fleet: context.fleet, campaigns });
const service = (id: string) => serviceReading({ model, service: id, items, reads: radar, now });
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

  it("qualifies itself on the radar reads that were cut or failed, and only then", () => {
    const read = (records: ReadRecord[]) =>
      upstreamReading({ model, items, radar: records, fleet: context.fleet, campaigns: [] });
    expect(upstream().qualifier).toBe(
      "GitLab cut the upstream diffs for 6 services and the reads failed for 3 services, so a toolchain move could be missing.",
    );
    const uncut = radar.filter((record) => record.completeness.kind !== "cut");
    expect(read(uncut).qualifier).toBe(
      "The reads failed for 3 services, so a toolchain move could be missing.",
    );
    const whole = uncut.filter((record) => record.failure === undefined);
    expect(read(whole)).not.toHaveProperty("qualifier");
  });

  it("folds the rest into one line and shows no internal names", () => {
    const reading = upstream();
    expect(reading.items).toHaveLength(5);
    expect(reading.folded).toContain("5 more forks move to os-core-common 8.5.0");
    expect(clean(reading)).toEqual([]);
  });
});

describe("Upstream reading with detected toolchain campaigns", () => {
  const eight = [
    "crs-conversion",
    "file",
    "indexer",
    "schema",
    "search",
    "storage",
    "unit",
    "workflow",
  ];
  const campaign = (fact: string, forks: string[]): ReadingCampaign => ({
    id: `campaign:toolchain:${encodeURIComponent(fact)}`,
    kind: "toolchain",
    fact,
    forks,
  });

  it("shows each campaign once, without action, and keeps the holds as their own items", () => {
    const reading = upstream([campaign("os-core-common 8.5.0", eight)]);
    expect(reading.items.map((item) => [item.id, item.group])).toEqual([
      ["radar:partition", "Before 18:00"],
      ["radar:legal", "Before 18:00"],
      ["campaign:toolchain:os-core-common%208.5.0", "Toolchain"],
    ]);
    const detected = reading.items[2];
    expect(detected).toMatchObject({
      title: "Detected: os-core-common 8.5.0 on 8 forks",
      scope: "8 forks",
      verb: "",
      next: "",
    });
    expect(detected?.ids).toEqual(expect.arrayContaining(eight.map((s) => `radar:${s}`)));
    const shown = reading.items.flatMap((item) => [item.scope, item.title, item.sub]);
    expect(shown.join(" ")).not.toMatch(/\bindexer\b|\bschema\b|\bstorage\b/);
    expect(reading.folded ?? "").not.toMatch(/os-core-common 8\.5\.0/);
    expect(reading.tiles[1]).toEqual({
      label: "Toolchain",
      value: "8 forks",
      counts: "move to os-core-common 8.5.0",
    });
  });

  it("keeps a fork outside every campaign as its own item, and names each campaign", () => {
    const reading = upstream([
      campaign(
        "os-core-common 8.5.0",
        eight.filter((s) => s !== "indexer" && s !== "unit"),
      ),
      campaign("os-core-common 10.0.0", ["indexer", "unit"]),
    ]);
    expect(reading.items.map((item) => item.title)).toEqual([
      expect.any(String),
      expect.any(String),
      "Detected: os-core-common 8.5.0 on 6 forks",
      "Detected: os-core-common 10.0.0 on 2 forks",
    ]);
    const lone = upstream([
      campaign(
        "os-core-common 8.5.0",
        eight.filter((s) => s !== "indexer"),
      ),
    ]);
    expect(lone.items.map((item) => item.id)).toContain("radar:indexer");
    expect(reading.tiles[1]?.counts).toBe("move to os-core-common 8.5.0 · 1 more move");
  });

  it("states the recorded 6 Nov campaigns once each and keeps them out of per-fork text", () => {
    const recorded = detectCampaigns(model);
    expect(recorded.map(({ fact, forks }) => [fact, forks])).toEqual([
      ["os-core-common 10.0.0", ["indexer", "schema", "unit"]],
      ["os-core-common 8.5.0", eight],
    ]);
    const reading = upstream(recorded);
    const titles = reading.items.map((item) => item.title);
    for (const { fact, forks } of recorded) {
      const title = `Detected: ${fact} on ${forks.length} forks`;
      expect(titles.filter((t) => t === title)).toHaveLength(1);
      expect(readingText(reading).filter((line) => line.includes(title))).toHaveLength(1);
    }
    const members = new Set(recorded.flatMap(({ forks }) => forks));
    const perFork = reading.items.filter((item) => !item.id.startsWith("campaign:"));
    for (const item of perFork) expect(members.has(item.scope)).toBe(false);
    const memberText = perFork
      .filter((item) => item.ids.some((id) => members.has(id.replace(/^radar:/, ""))))
      .flatMap((item) => [item.title, item.sub, item.cause, item.effect, item.next]);
    expect(memberText).toEqual([]);
    expect(reading.folded ?? "").not.toMatch(/os-core-common (8\.5\.0|10\.0\.0)/);
    expect(reading.folded ?? "").not.toMatch(new RegExp(`\\b(${[...members].join("|")})\\b(?!-)`));
  });
});

describe("Upstream reading before anything was read", () => {
  const empty = buildModel(emptyFacts(), now, {}, context);
  const zero = {
    ...model,
    upstream: {
      ...model.upstream,
      unread: 0,
      moving: [],
      held: [],
      moves: [],
      forks: model.upstream.forks.map((fork) => ({ ...fork, behind: 0 })),
    },
  };
  const read = (m: typeof model) =>
    upstreamReading({ model: m, items: [], radar: [], fleet: context.fleet, campaigns: [] });

  it("reads unread forks as not read yet, never as zero", () => {
    const reading = read(empty);
    expect(empty.upstream.unread).toBe(13);
    expect(reading.headline).toBe("Upstream not read yet.");
    expect(reading.tiles.map((tile) => tile.value)).toEqual([NOT_READ, NOT_READ, NOT_READ]);
    expect(readingText(reading).join(" ")).not.toMatch(/Nothing queued|no fork behind|\b0\b/);
  });

  it("reads a measured zero as nothing queued", () => {
    const reading = read(zero);
    expect(reading.headline).toBe("Nothing queued upstream for the next sync.");
    expect(reading.tiles.map((tile) => tile.value)).toEqual(["0", "0 forks", "0"]);
    expect(reading.tiles[2]?.counts).toBe("commits · no fork behind");
  });

  it("names the forks not read beside a zero from the forks read", () => {
    const reading = read({ ...zero, upstream: { ...zero.upstream, unread: 3 } });
    expect(reading.headline).toBe("Nothing queued on the forks read; 3 not read yet.");
    expect(reading.tiles[0]?.counts).toBe("commits · 0 of 13 forks · 3 not read yet");
  });

  it("reads an unread service as not read yet", () => {
    const reading = serviceReading({
      model: empty,
      service: "partition",
      items: [],
      reads: [],
      now,
    });
    expect(reading?.tiles.map((tile) => tile.value)).toEqual([NOT_READ, NOT_READ, NOT_READ]);
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

  it("reads entitlements in well under 150 words with a release review", () => {
    const reading = service("entitlements");
    if (!reading) throw new Error("no entitlements reading");
    expect(reading.headline).toBe("Cascade stopped on a merge conflict.");
    expect(reading.tiles.map((tile) => tile.label)).toEqual(["Upstream", "Line", "Release review"]);
    expect(reading.items[0]).toMatchObject({ rung: 0, group: "Stopped" });
    expect(readingWords(reading)).toBeGreaterThanOrEqual(60);
    expect(readingWords(reading)).toBeLessThanOrEqual(150);
  });

  it("strips raw issue and check emoji from display text, keeping ids and evidence", () => {
    const reading = service("entitlements");
    if (!reading) throw new Error("no entitlements reading");
    expect(readingText(reading).join(" ")).not.toMatch(/\p{Extended_Pictographic}/u);
    const release = reading.items.find((item) => item.id.startsWith("release-red:"));
    expect(release?.title).toBe("Release PR #89 fails Code Coverage");
    for (const item of reading.items) {
      const raw = items.find((i) => i.id === item.id);
      if (item.id === "repo:entitlements") continue;
      expect(item.ids).toEqual(raw?.ids);
      expect(item.evidence).toEqual(raw?.evidence);
    }
    expect(reading.tiles[2]?.counts).toMatch(/^checks fail|^fails Code Coverage/);
  });

  it("shows only service-local items, leaving fleet aggregates to Today", () => {
    for (const id of services) {
      const reading = service(id);
      for (const item of reading?.items ?? []) expect(item.scope, id).toBe(id);
      expect(readingText(reading ?? upstream()).join(" "), id).not.toMatch(/12 forks/);
    }
  });

  it("qualifies a service only on its own failed or cut reads, not on its blocked state", () => {
    expect(service("unit")?.qualifier).toBe(
      "A read failed for this service, so this reading could be missing something.",
    );
    const clean = radar.filter(
      (record) => record.failure === undefined && record.completeness.kind !== "cut",
    );
    const blocked = serviceReading({ model, service: "entitlements", items, reads: clean, now });
    expect(blocked?.headline).toBe("Cascade stopped on a merge conflict.");
    expect(blocked).not.toHaveProperty("qualifier");
  });

  it("caps a service at five items and folds the rest", () => {
    const extra: FocusItem[] = Array.from({ length: 7 }, (_, n) => ({
      ...(items[0] as FocusItem),
      id: `extra:entitlements:${n}`,
      ids: [`extra:entitlements:${n}`],
      rung: 2,
      scope: "entitlements",
      title: `Extra ${n}`,
    }));
    const reading = serviceReading({
      model,
      service: "entitlements",
      items: [...items, ...extra],
      reads: radar,
      now,
    });
    expect(reading?.items).toHaveLength(5);
    expect(reading?.folded).toMatch(/^5 more items: /);
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
      reads: radar,
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
