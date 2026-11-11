// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { attentionOf, LEAD_TIME_MS } from "../src/attention.js";
import { buildBriefing, type FocusItem } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { ReadRecord } from "../src/evidence/index.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { detectCampaigns } from "../src/model/campaigns.js";
import { buildModel, type Model } from "../src/model/index.js";
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
// The next sync as an instant; the window reads it in its own zone (18:00 in Chicago).
const SYNC = "2026-11-07T00:00:00.000Z";

// Storage's open sync PR named for an upstream sha that isn't among its queued commits.
const unaimed = (() => {
  const f = structuredClone(facts);
  const pr = f.github.data?.repos["Azure/osdu-spi-storage"]?.prs.find((p) => p.number === 58);
  if (!pr) throw new Error("storage sync PR #58 is missing from the sweep");
  pr.title = "⬆️ Sync with upstream 0badc0de";
  const m = buildModel(f, now, {}, context);
  const b = buildBriefing(m, { state: "clear", problems: [] }, now, context);
  return { model: m, items: [...b.focus, ...b.rest] };
})();

// Indexer's two commits newer than sync PR #58's target listed ahead of it.
const reordered = (() => {
  const f = structuredClone(facts);
  const queue = f.upstream.data?.indexer?.commits;
  if (!queue || queue.length < 2)
    throw new Error("indexer's queued commits are missing from the sweep");
  queue.unshift(...queue.splice(-2));
  const m = buildModel(f, now, {}, context);
  const b = buildBriefing(m, { state: "clear", problems: [] }, now, context);
  return { model: m, items: [...b.focus, ...b.rest] };
})();

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
    expect(reading.headline).toBe(`At ${SYNC}, 73 commits reach 9 forks. Two need you first.`);
    expect(wordCount(reading.headline)).toBeLessThanOrEqual(12);
    expect(reading.tiles[0]).toEqual({
      label: "Incoming",
      value: "107",
      counts: `commits · 34 in 2 sync PRs · 73 at ${SYNC}`,
    });
  });

  it("keeps only the commits an open sync PR already holds out of the next sync's count", () => {
    const held = (keep: (f: Model["upstream"]["moving"][number]) => boolean, from = model) => {
      const m = structuredClone(from);
      m.upstream.held = [];
      m.upstream.moving = m.upstream.moving.filter(keep);
      return upstreamReading({ model: m, items, radar, fleet: context.fleet, campaigns: [] })
        .headline;
    };
    expect(held(() => true)).toBe(`At ${SYNC}, 73 commits reach 9 forks; 34 in sync PRs.`);
    expect(held((f) => f.service === "indexer")).toBe(`At ${SYNC}, 2 commits reach 1 fork.`);
    expect(held((f) => f.service === "storage")).toBe("11 commits wait in 1 open sync PR.");
    expect(held((f) => f.service === "schema")).toBe(`At ${SYNC}, 16 commits reach 1 fork.`);
    expect(held((f) => f.service === "storage", unaimed.model)).toBe(
      `At ${SYNC}, 11 commits reach 1 fork.`,
    );
    expect(held((f) => f.service === "indexer", reordered.model)).toBe(
      `At ${SYNC}, 25 commits reach 1 fork.`,
    );
    expect(
      upstreamReading({ model: reordered.model, items, radar, fleet: context.fleet, campaigns: [] })
        .tiles[0],
    ).toEqual({
      label: "Incoming",
      value: "107",
      counts: `commits · 11 in 1 sync PR · 96 at ${SYNC}`,
    });
  });

  it("holds nothing when the PR's lone target commit has an unreadable time", () => {
    const f = structuredClone(facts);
    const storage = f.upstream.data?.storage;
    const target = storage?.commits.at(-1);
    if (!storage || !target) throw new Error("storage's queued commits are missing from the sweep");
    storage.commits = [{ ...target, at: "not a time" }];
    const fork = buildModel(f, now, {}, context).upstream.forks.find(
      (k) => k.service === "storage",
    );
    expect(fork?.syncPr?.number).toBe(58);
    expect(fork?.syncPr?.holds).toBeUndefined();
  });

  it("names the open sync PR for the commits it holds and the next sync for the rest", () => {
    const radarItem = (service: string, from = items) =>
      from.find((item) => item.id === `radar:${service}`);
    expect(radarItem("indexer")).toMatchObject({
      title: "Sync PR #58 and the next sync carry os-core-common 8.5.0",
      sub: `23 commits in sync PR #58 · 2 more at ${SYNC}`,
      effect: "23 commits wait in sync PR #58; 2 more reach the fork at the 18:00 sync.",
      next: "Absorb os-core-common 8.5.0 on the fork before merging sync PR #58.",
    });
    expect(radarItem("storage")).toMatchObject({
      title: "Sync PR #58 carries os-core-common 8.5.0",
      sub: "11 commits in sync PR #58",
      effect: "11 commits wait in sync PR #58 and reach the fork when it merges.",
      next: "Absorb os-core-common 8.5.0 on the fork before merging sync PR #58.",
    });
    expect(radarItem("schema")).toMatchObject({
      title: "Next sync carries os-core-common 8.5.0",
      sub: `16 commits queued · syncs at ${SYNC}`,
      effect: "16 commits reach the fork at the 18:00 sync.",
    });
    expect(radarItem("storage", unaimed.items)).toMatchObject({
      title: "Next sync carries os-core-common 8.5.0",
      sub: `11 commits queued · syncs at ${SYNC}`,
      effect: "11 commits reach the fork at the 18:00 sync.",
    });
    expect(radarItem("indexer", reordered.items)).toMatchObject({
      title: "Next sync carries os-core-common 8.5.0",
      sub: `25 commits queued · syncs at ${SYNC}`,
      effect: "25 commits reach the fork at the 18:00 sync.",
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
      expect(item).toMatchObject({ rung: 1, group: `Before ${SYNC}` });
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
      "GitLab truncated the upstream diffs for 6 services and the reads failed for 3 services, so a toolchain move could be missing.",
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

describe("Radar items whose commits sit in their fork's open sync PR on the recorded 6 Nov sweep", () => {
  const NEXT_SYNC = "2026-11-07T00:00:00.000Z";
  const inLead = new Date(Date.parse(NEXT_SYNC) - 60 * 60 * 1000);
  const tier = (service: string, from = model, at = inLead) => {
    const id = `radar:${service}`;
    const subject = { id, ids: [id], rung: 1 };
    const previous = [{ ...subject, attention: "surface" as const, owned: false }];
    return attentionOf(subject, from, { now: at, leadTimeMs: LEAD_TIME_MS, previous });
  };
  const due = { at: NEXT_SYNC, before: "next sync" };
  const escalated = { attention: "interrupt", owned: false, due };
  const rebuilt = (edit: (f: Facts) => void) => {
    const f = structuredClone(facts);
    edit(f);
    return buildModel(f, now, {}, context);
  };
  // Storage's first queued commit dated after sync PR #58's target, so times don't confirm the order.
  const disordered = rebuilt((f) => {
    const commits = f.upstream.data?.storage?.commits;
    const [first, target] = [commits?.[0], commits?.at(-1)];
    if (!first || !target) throw new Error("storage's queued commits are missing from the sweep");
    first.at = new Date(Date.parse(target.at) + 60_000).toISOString();
  });
  // Storage's sync PR not among the PRs read.
  const unread = rebuilt((f) => {
    const repo = f.github.data?.repos["Azure/osdu-spi-storage"];
    if (!repo) throw new Error("storage's repo is missing from the sweep");
    repo.prs = repo.prs.filter((p) => p.number !== 58);
  });

  // Storage's filter without its top-level pom.xml rule, so the queued commits halt the next sync.
  const halting = rebuilt((f) => {
    const filter = f.radar.data?.filters.storage;
    if (!filter) throw new Error("storage's filter is missing from the sweep");
    filter.text = filter.text.replace(/^ {2}pom\.xml: keep\n/m, "");
  });

  it("keeps a held item at Surface with no due time while a queued fork's item escalates", () => {
    expect(tier("storage", model, now)).toEqual({ attention: "surface", owned: false });
    expect(tier("storage")).toEqual({ attention: "surface", owned: false });
    expect(tier("schema", model, now)).toEqual({ attention: "surface", owned: false, due });
    expect(tier("schema")).toEqual(escalated);
    expect(tier("indexer")).toEqual(escalated);
  });

  it("treats the item as queued when core can't prove the sync PR holds its commits", () => {
    const pr = disordered.upstream.forks.find((f) => f.service === "storage")?.syncPr;
    expect([pr?.number, pr?.holds]).toEqual([58, undefined]);
    expect(tier("storage", unaimed.model)).toEqual(escalated);
    expect(tier("storage", disordered)).toEqual(escalated);
    expect(tier("storage", unread)).toEqual(escalated);
  });

  it("still escalates a held item whose queued commits will halt the next sync", () => {
    const item = halting.queue.items.find((q) => q.id === "radar:storage");
    expect(item?.text).toMatch(/^next sync will halt on pom\.xml.* · 11 commits in sync PR #58$/);
    expect(tier("storage", halting)).toEqual(escalated);
    const m = structuredClone(halting);
    m.queue.items = m.queue.items.filter((q) => q.id === "radar:storage");
    expect(buildBriefing(m, { state: "clear", problems: [] }, now, context).headline).toBe(
      "Classify pom.xml on storage before the 18:00 sync.",
    );
  });

  it("names the sync PR in a held fork's queue text", () => {
    const text = (service: string, from = model) =>
      from.queue.items.find((q) => q.id === `radar:${service}`)?.text;
    expect(text("storage")).toBe(
      "sync PR #58 carries os-core-common 8.5.0 · 11 commits in sync PR #58",
    );
    expect(text("indexer")).toBe(
      "sync PR #58 and the next sync carry os-core-common 8.5.0 · 23 commits in sync PR #58 · 2 more at the next sync",
    );
    expect(text("schema")).toBe("next sync carries os-core-common 8.5.0 · 16 commits queued");
    expect(text("storage", unaimed.model)).toBe(
      "next sync carries os-core-common 8.5.0 · 11 commits queued",
    );
  });

  it("keeps the next sync's time for a held will-halt item's effect and sub", () => {
    const b = buildBriefing(halting, { state: "clear", problems: [] }, now, context);
    const item = [...b.focus, ...b.rest].find((i) => i.id === "radar:storage");
    expect(item?.effect).toBe("11 commits reach the fork at the 18:00 sync.");
    expect(item?.sub).toBe(`11 commits queued · syncs at ${NEXT_SYNC}`);
  });

  it("groups a held item as a decision in its service reading, not before the next sync", () => {
    const group = (service: string, from: { model: Model; items: FocusItem[] }) =>
      serviceReading({ ...from, service, reads: radar, now })?.items.find(
        (i) => i.id === `radar:${service}`,
      )?.group;
    expect(group("storage", { model, items })).toBe("Needs a decision");
    expect(group("indexer", { model, items })).toBe("Before 18:00");
    expect(group("schema", { model, items })).toBe("Before 18:00");
    expect(group("storage", unaimed)).toBe("Before 18:00");
  });

  it("names the sync PR in a held fork's queued cause", () => {
    const waits = (service: string, from = model) =>
      from.queue.items
        .find((q) => q.id === `radar:${service}`)
        ?.cause.find((f) => f.label === "queued")?.value;
    expect(waits("storage")).toBe("11 commits wait in sync PR #58");
    expect(waits("indexer")).toBe(
      "23 commits wait in sync PR #58; 2 more wait for the next Sync Upstream at 00:00Z",
    );
    expect(waits("schema")).toBe("16 commits wait for the next Sync Upstream at 00:00Z");
    expect(waits("storage", unaimed.model)).toBe(
      "11 commits wait for the next Sync Upstream at 00:00Z",
    );
  });

  it("keeps a dismissed item dismissed when its fork's sync PR comes to hold its commits", () => {
    const queued = unaimed.model.queue.items.find((q) => q.id === "radar:storage");
    if (!queued?.fingerprint) throw new Error("storage's radar item is missing");
    const entry = { id: queued.id, fingerprint: queued.fingerprint };
    const held = buildModel(facts, now, { dismissed: [entry] }, context);
    expect(held.queue.dismissed.map((d) => d.item.id)).toEqual(["radar:storage"]);
    expect(held.queue.items.some((q) => q.id === "radar:storage")).toBe(false);
  });

  it("adds no next-sync time to the headline for a held radar lead", () => {
    const headline = (service: string, from = model) => {
      const m = structuredClone(from);
      m.queue.items = m.queue.items.filter((q) => q.id === `radar:${service}`);
      return buildBriefing(m, { state: "clear", problems: [] }, now, context).headline;
    };
    expect(headline("storage")).toBe("Absorb the toolchain move on storage.");
    expect(headline("indexer")).toBe("Absorb the toolchain move on indexer before the 18:00 sync.");
    expect(headline("storage", unaimed.model)).toBe(
      "Absorb the toolchain move on storage before the 18:00 sync.",
    );
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
      ["radar:partition", `Before ${SYNC}`],
      ["radar:legal", `Before ${SYNC}`],
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

  it.each([false, true])(
    "uses window wording for truncated service reads (failed: %s)",
    (failed) => {
      const reads = radar
        .filter((record) => record.completeness.kind === "cut")
        .map((record) => ({ ...record, ...(failed ? { failure: "HTTP 502" } : {}) }));
      const reading = serviceReading({ model, service: "entitlements", items, reads, now });
      expect(reading?.qualifier).toContain("GitLab truncated this service's upstream diffs");
      expect(reading?.qualifier).not.toMatch(/\bcut\b/i);
      expect(reading?.qualifier).toContain(
        failed ? "a read failed" : "a toolchain move could be missing",
      );
    },
  );

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
    expect(internalNames("GitLab truncated the upstream diffs")).toEqual([]);
  });
});

describe("Watch snapshot qualifiers", () => {
  it("keeps the internal word cut out of every emitted qualifier", () => {
    const root = new URL("../../../fixtures/watch/", import.meta.url);
    const snapshots = readdirSync(root).filter(
      (name) => name.startsWith("snapshot") && name.endsWith(".json"),
    );
    expect(snapshots.length).toBeGreaterThan(0);
    let qualifiers = 0;
    for (const name of snapshots) {
      const snapshot: {
        readings: { anchor: unknown; content: PlaceReading<ReadingItem> | null }[];
      } = JSON.parse(readFileSync(new URL(name, root), "utf8"));
      expect(snapshot.readings.length, name).toBeGreaterThan(0);
      for (const { anchor, content } of snapshot.readings) {
        if (!content?.qualifier) continue;
        qualifiers++;
        expect(content.qualifier, `${name}: ${JSON.stringify(anchor)}`).not.toMatch(/\bcut\b/i);
      }
    }
    expect(qualifiers).toBeGreaterThan(0);
  });
});
