// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { buildBriefing, buildModel, horizonCards, LEAD_TIME_MS } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { itemAttention } from "./attention.js";
import { projectWatch, type WatchInput } from "./project.js";
import {
  badInput,
  busyInput,
  calmInput,
  fixtureInput,
  mixedFixtureInput,
  recordedInput,
  unreadForksInput,
  unverifiedForkInput,
} from "./snapshot-fixture.js";

process.env.TZ = "UTC";

type View = ReturnType<typeof projectWatch>;

const itemsOf = (view: View) => [...view.briefing.focus, ...view.briefing.rest];
const cardsOf = (view: View) => view.briefing.horizon.cards ?? [];
const card = (view: View, token: string) => {
  const found = cardsOf(view).find((c) => c.token === token);
  if (!found) throw new Error(`No horizon card for ${token}`);
  return found;
};
const stages = (view: View, token: string) =>
  card(view, token).services.map(({ service, stage, pr }) =>
    pr ? `${service} ${stage} #${pr.number}` : `${service} ${stage}`,
  );
const upstreamReading = (view: View) => {
  const reading = view.readings.find((r) => r.anchor.kind === "upstream")?.content;
  if (!reading) throw new Error("No Upstream reading");
  return reading;
};

const MORNINGS = [
  ["busy", busyInput],
  ["bad", badInput],
  ["calm", calmInput],
  ["6 Nov", recordedInput],
  ["59d6895", fixtureInput],
] as const;

const RECORDED = [
  ...MORNINGS,
  ["mixed 59d6895", mixedFixtureInput],
  ["6 Nov unread", unreadForksInput],
  ["6 Nov unverified", unverifiedForkInput],
] as const;

const fresh = (input: WatchInput): WatchInput => ({
  ...input,
  attention: {
    leadTimeMs: input.attention?.leadTimeMs ?? LEAD_TIME_MS,
    previous: [],
    ...(input.attention?.cards ? { cards: input.attention.cards } : {}),
  },
});

// Tiers straight from core, before the projection builds the horizon or Decisions waiting.
function tiered(input: WatchInput) {
  const now = input.context.clock.now();
  const model = buildModel(input.facts, now, {}, input.context);
  const briefing = buildBriefing(model, input.doctor, now, input.context);
  return [...briefing.focus, ...briefing.rest].map((item) => ({
    ...item,
    ...itemAttention(item, model, input, input.attention),
  }));
}

// Upstream Surface items no horizon card holds yet (spicode-f0s.42): a sync PR no held change
// joins, and ports. Each entry leaves as that bead gives it a home.
const NO_CARD_YET: Readonly<Record<string, readonly string[]>> = {
  "6 Nov": ["gate1:indexer", "gate1:indexer-queue", "port:entitlements"],
  "6 Nov, fresh": ["gate1:indexer", "gate1:indexer-queue", "port:entitlements"],
  "59d6895": ["gate1:legal", "port:entitlements"],
  "59d6895, fresh": ["gate1:legal", "port:entitlements"],
  "mixed 59d6895": ["gate1:legal", "port:entitlements"],
  "mixed 59d6895, fresh": ["gate1:legal", "port:entitlements"],
  "6 Nov unread": ["gate1:indexer", "port:entitlements"],
  "6 Nov unread, fresh": ["gate1:indexer", "port:entitlements"],
  "6 Nov unverified": ["gate1:indexer", "gate1:indexer-queue", "port:entitlements"],
  "6 Nov unverified, fresh": ["gate1:indexer", "gate1:indexer-queue", "port:entitlements"],
};

describe("horizon cards on snapshot-busy", () => {
  const view = projectWatch(busyInput());

  it("names the three forks holding os-core-common 8.5.0 with their sync PRs and Absorb", () => {
    const absorb = card(view, "os-core-common 8.5.0");
    expect(stages(view, "os-core-common 8.5.0")).toEqual([
      "indexer held #58",
      "workflow held #59",
      "unit held #60",
    ]);
    expect(absorb.services.map((s) => s.pr?.inspect)).toEqual([
      "gate1:indexer",
      "gate1:workflow",
      "gate1:unit",
    ]);
    expect(absorb).toMatchObject({
      kind: "toolchain",
      needsYou: true,
      mark: "needs-person",
      verb: "Absorb",
      itemIds: [
        "radar:indexer",
        "radar:workflow",
        "radar:unit",
        "gate1:indexer",
        "gate1:workflow",
        "gate1:unit",
      ],
    });
    expect(absorb.text).toMatch(/Absorb it before merging\.$/);
  });

  it("builds the halt card and the Java card from the same stages", () => {
    expect(card(view, "schemathesis-tests")).toMatchObject({
      kind: "halt",
      needsYou: true,
      verb: "Pre-classify",
      itemIds: ["radar:legal"],
    });
    expect(stages(view, "schemathesis-tests")).toEqual(["legal wont-land"]);
    const java = card(view, "Java 25");
    expect(java).toMatchObject({ kind: "toolchain", needsYou: true, verb: "Move pin" });
    expect(stages(view, "Java 25")).toEqual(["storage wont-land", "crs-conversion queued"]);
    expect(java.services.find((s) => s.stage === "queued")?.at).toBe(
      view.briefing.horizon.stages?.nextSync.at,
    );
  });

  it("counts seven Surface items in four cards, and the Upstream reading counts the same items", () => {
    const surface = new Set(
      itemsOf(view).flatMap((i) => (i.attention === "surface" ? [i.id] : [])),
    );
    expect(cardsOf(view)).toHaveLength(4);
    expect(cardsOf(view).flatMap((c) => c.itemIds.filter((id) => surface.has(id)))).toHaveLength(7);
    expect(view.briefing.horizon.counts).toEqual({
      needYouCards: 4,
      toWatchCards: 0,
      surfaceItems: 7,
      text: "4 need you before they land",
    });
    expect(upstreamReading(view).headline).toMatch(/ Seven need you first\.$/);
  });

  it("counts the sync PRs holding 8.5.0 on its card once they surface", () => {
    const surfaced = projectWatch(fresh(busyInput()));
    const absorb = card(surfaced, "os-core-common 8.5.0");
    expect(absorb.itemIds.filter((id) => id.startsWith("gate1:"))).toEqual([
      "gate1:indexer",
      "gate1:workflow",
      "gate1:unit",
    ]);
    expect(surfaced.briefing.horizon.counts).toEqual({
      needYouCards: 4,
      toWatchCards: 0,
      surfaceItems: 10,
      text: "4 need you before they land",
    });
    expect(upstreamReading(surfaced).headline).toMatch(/ 10 need you first\.$/);
  });

  it("marks a held card that only its sync PR surfaces", () => {
    const input = fresh(busyInput());
    const now = input.context.clock.now();
    const model = buildModel(input.facts, now, {}, input.context);
    const briefing = buildBriefing(model, input.doctor, now, input.context);
    const items = [...briefing.focus, ...briefing.rest].map((item) => ({
      ...item,
      attention: item.id === "gate1:workflow" ? ("surface" as const) : ("ambient" as const),
    }));
    const { cards, counts } = horizonCards({ model, items, themes: briefing.themes });
    expect(cards.find((c) => c.token === "os-core-common 8.5.0")).toMatchObject({
      needsYou: true,
      mark: "needs-person",
      verb: "Absorb",
    });
    expect(counts.surfaceItems).toBe(1);
  });

  it("keeps the Surface count in the headline when nothing lands at the next sync", () => {
    const input = busyInput();
    for (const repo of Object.values(input.facts.github.data?.repos ?? {})) {
      repo.prs = repo.prs.filter((pr) => pr.head !== "sync/upstream-morning");
    }
    for (const runs of Object.values(input.facts.runs.data ?? {})) {
      for (const run of runs.sync) run.conclusion = "failure";
    }
    const view = projectWatch(input);
    const stages = view.briefing.horizon.stages;
    expect(stages?.nextSync.count).toBe(0);
    expect(stages?.held.count).toBe(0);
    expect(view.briefing.horizon.counts?.surfaceItems).toBe(7);
    expect(upstreamReading(view).headline).toMatch(
      /^Nothing lands at the next sync; \d+ commits won't land\. Seven need you first\.$/,
    );
  });
});

describe("ruling R1 on the horizon and Decisions waiting", () => {
  for (const [morning, make] of RECORDED) {
    for (const [name, input] of [
      [morning, make()],
      [`${morning}, fresh`, fresh(make())],
    ] as const) {
      it(`gives every Surface item on the ${name} morning exactly one home`, () => {
        const expected = tiered(input);
        const view = projectWatch(input);
        const tiers = (items: readonly { id: string; attention: string }[]) =>
          items.map((i) => `${i.id} ${i.attention}`).sort();
        expect(tiers(itemsOf(view))).toEqual(tiers(expected));
        const homes = new Map<string, string[]>();
        const home = (id: string, where: string) =>
          homes.set(id, [...(homes.get(id) ?? []), where]);
        for (const c of cardsOf(view)) for (const id of c.itemIds) home(id, c.id);
        for (const g of view.briefing.decisions?.groups ?? []) {
          for (const id of g.itemIds) home(id, g.id);
        }
        const surface = expected.filter((i) => i.attention === "surface");
        const allowed = NO_CARD_YET[name] ?? [];
        const homeless = surface.filter((i) => !homes.has(i.id));
        expect(homeless.map((i) => i.id).sort()).toEqual([...allowed].sort());
        for (const item of homeless) {
          expect(item.origin, item.id).toBe("upstream");
          expect(/^(gate1|port):/.test(item.id), item.id).toBe(true);
        }
        for (const item of surface.filter((i) => !allowed.includes(i.id))) {
          expect(homes.get(item.id), item.id).toHaveLength(1);
          const where = homes.get(item.id)?.[0] ?? "";
          expect(where.startsWith("decision:"), item.id).toBe(item.origin === "system");
        }
        expect(view.briefing.decisions?.items).toBe(
          surface.filter((i) => i.origin === "system").length,
        );
      });
    }
  }

  it("keeps an upstream item that escalates to Interrupt in Needs you, with ✕ on its card", () => {
    const input = busyInput();
    const view = projectWatch({
      ...input,
      attention: {
        ...(input.attention ?? { leadTimeMs: 0, previous: [] }),
        cards: new Set(["radar:indexer"]),
      },
    });
    expect(itemsOf(view).find((i) => i.id === "radar:indexer")?.attention).toBe("interrupt");
    expect(card(view, "os-core-common 8.5.0")).toMatchObject({
      needsYou: true,
      mark: "stopped",
      itemIds: [
        "radar:indexer",
        "radar:workflow",
        "radar:unit",
        "gate1:indexer",
        "gate1:workflow",
        "gate1:unit",
      ],
    });
    expect(view.briefing.horizon.counts?.surfaceItems).toBe(6);
    expect(upstreamReading(view).headline).toMatch(/ Six need you first\.$/);
    expect(view.briefing.decisions?.groups.flatMap((g) => g.itemIds)).not.toContain(
      "radar:indexer",
    );
  });

  it("marks a card ✕ when the sync PR holding its change escalates", () => {
    const input = busyInput();
    const view = projectWatch({
      ...input,
      attention: {
        ...(input.attention ?? { leadTimeMs: 0, previous: [] }),
        cards: new Set(["gate1:workflow"]),
      },
    });
    expect(card(view, "os-core-common 8.5.0").mark).toBe("stopped");
    expect(view.briefing.horizon.counts?.surfaceItems).toBe(7);
  });

  it("groups system Surface items by core theme and leaves upstream ones to the cards", () => {
    const view = projectWatch(busyInput());
    expect(view.briefing.decisions).toMatchObject({ items: 4, text: "4 in 4 themes" });
    expect(view.briefing.decisions?.groups.map((g) => [g.theme, g.itemIds])).toEqual([
      ["rollout", ["rollout"]],
      ["stack:lanes", ["stack:lanes"]],
      ["labels:schema", ["labels:schema"]],
      ["security:dependabot:fixture-library", ["security:dependabot:fixture-library"]],
    ]);
  });
});

describe("one grouping for Today's horizon and the Upstream place", () => {
  for (const [name, make] of MORNINGS) {
    it(`gives each toolchain card its campaign's forks on the ${name} morning`, () => {
      const view = projectWatch(make());
      for (const campaign of view.campaigns.filter((c) => c.kind === "toolchain")) {
        expect(
          card(view, campaign.fact)
            .services.map((s) => s.service)
            .sort(),
          campaign.id,
        ).toEqual([...campaign.forks].sort());
      }
    });

    it(`renders the same record ids on the horizon and the Upstream place on the ${name} morning`, () => {
      const view = projectWatch(make());
      const horizon = cardsOf(view)
        .flatMap((c) => c.itemIds)
        .sort();
      const place = [...new Set(upstreamReading(view).items.flatMap((i) => i.ids))].sort();
      expect(place).toEqual(horizon);
    });

    it(`counts the horizon's Surface items in the Upstream headline on the ${name} morning`, () => {
      const view = projectWatch(make());
      const counts = view.briefing.horizon.counts;
      const cards = cardsOf(view);
      expect(counts?.needYouCards).toBe(cards.filter((c) => c.needsYou).length);
      expect(counts?.toWatchCards).toBe(cards.filter((c) => !c.needsYou).length);
      const surface = itemsOf(view).filter(
        (i) => i.attention === "surface" && cards.some((c) => c.itemIds.includes(i.id)),
      );
      expect(counts?.surfaceItems).toBe(surface.length);
      const words = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven"];
      const said = / (\w+) needs? you first\.$/.exec(upstreamReading(view).headline)?.[1];
      expect(
        said === undefined ? 0 : words.indexOf(said) >= 0 ? words.indexOf(said) : Number(said),
      ).toBe(surface.length);
      expect(cards.flatMap((c) => c.services).some((s) => s.stage === "landed")).toBe(false);
    });
  }
});

describe("the horizon fails toward not proven", () => {
  const unreadPartition = (): WatchInput => {
    const input = busyInput();
    delete input.facts.upstream.data?.partition;
    return input;
  };

  it("reads a fork whose upstream lag was not read as unknown, never queued", () => {
    const view = projectWatch(unreadPartition());
    expect(stages(view, "os-core-common 10.0.0")).toEqual(["partition unknown"]);
    expect(card(view, "os-core-common 10.0.0").text).toMatch(/Not fully read on partition\.$/);
  });

  it("reads a fork whose sync PR holds only part of its queued commits as unknown", () => {
    const view = projectWatch(recordedInput());
    expect(stages(view, "os-core-common 8.5.0")).toContain("indexer unknown");
  });

  it("never claims calm when a card's forks were not fully read", () => {
    const input = unreadPartition();
    const now = input.context.clock.now();
    const model = buildModel(input.facts, now, {}, input.context);
    const briefing = buildBriefing(model, input.doctor, now, input.context);
    const quiet = [...briefing.focus, ...briefing.rest].map((item) => ({
      ...item,
      attention: "ambient" as const,
    }));
    const read = horizonCards({
      model: buildModel(busyInput().facts, now, {}, input.context),
      items: quiet,
      themes: briefing.themes,
    });
    expect(read.counts.needYouCards).toBe(0);
    expect(read.counts.text).toBe("Nothing needs you before it lands · 4 to watch");
    const { counts, cards } = horizonCards({ model, items: quiet, themes: briefing.themes });
    expect(counts.needYouCards).toBe(0);
    expect(counts.text).not.toMatch(/^Nothing needs you/);
    expect(counts.text).toMatch(/not fully read$/);
    expect(cards.every((c) => c.mark === undefined && c.verb === undefined)).toBe(true);
    const cut = horizonCards({
      model: buildModel(busyInput().facts, now, {}, input.context),
      items: quiet,
      themes: briefing.themes,
      unread: ["indexer"],
    });
    expect(cut.counts.text).not.toMatch(/^Nothing needs you/);
  });
});

describe("the horizon headline agrees with the stages", () => {
  it("never denies the calm morning's two queued commits", () => {
    const view = projectWatch(calmInput());
    const { headline, stages: horizon } = view.briefing.horizon;
    expect(horizon?.nextSync.count).toBe(2);
    expect(headline).toBe("2 commits reach 2 forks at the next sync.");
    expect(view.briefing.horizon.counts?.text).toBe("Nothing needs you before it lands");
  });

  it("says nothing lands when the only queued commits are on stopped or halted syncs", () => {
    const input = calmInput();
    const runs = input.facts.runs.data?.["Azure/osdu-spi-partition"]?.sync[0];
    if (!runs) throw new Error("Calm fixture lacks partition's sync run");
    runs.conclusion = "failure";
    delete input.facts.upstream.data?.schema;
    const view = projectWatch(input);
    expect(view.briefing.horizon.stages?.wontLand.map((f) => f.service)).toEqual(["partition"]);
    expect(view.briefing.horizon.headline).toBe("1 commit won't land; 1 fork not read yet.");
  });

  it("stays honest when nothing is queued", () => {
    const input = calmInput();
    for (const service of ["partition", "schema"]) {
      const upstream = input.facts.upstream.data?.[service];
      const radar = input.facts.radar.data?.services[service];
      if (!upstream || !radar) throw new Error(`Calm fixture lacks ${service}`);
      upstream.lag = 0;
      upstream.commits = [];
      radar.queued = [];
    }
    const view = projectWatch(input);
    expect(view.briefing.horizon.headline).toBe("Nothing queued upstream for the next sync.");
  });
});
