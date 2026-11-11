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
      /^Nothing lands; \d+ commits won't land\. Seven need you first\.$/,
    );
  });
});

describe("ruling R1 across Today", () => {
  for (const [morning, make] of RECORDED) {
    for (const [name, input] of [
      [morning, make()],
      [`${morning}, fresh`, fresh(make())],
    ] as const) {
      it(`gives every item on the ${name} morning exactly one home`, () => {
        const expected = tiered(input);
        const view = projectWatch(input);
        const tiers = (items: readonly { id: string; attention: string }[]) =>
          items.map((i) => `${i.id} ${i.attention}`).sort();
        expect(tiers(itemsOf(view))).toEqual(tiers(expected));
        const homes = new Map<string, string[]>();
        const home = (id: string, where: string) =>
          homes.set(id, [...(homes.get(id) ?? []), where]);
        const tiersById = new Map(expected.map((item) => [item.id, item.attention]));
        for (const item of expected) {
          if (item.attention === "interrupt") home(item.id, "needs-you");
        }
        for (const c of cardsOf(view)) {
          for (const id of c.itemIds) {
            if (tiersById.get(id) !== "interrupt") home(id, c.id);
          }
        }
        for (const id of view.briefing.horizon.owed?.itemIds ?? []) {
          if (tiersById.get(id) !== "interrupt") home(id, "owed");
        }
        for (const g of view.briefing.decisions?.groups ?? []) {
          for (const id of g.itemIds) home(id, g.id);
        }
        expect(view.briefing.ambient).toBeDefined();
        expect(view.briefing.canWait).toBeDefined();
        for (const [run, label] of [
          [view.briefing.ambient?.failing, "failing"],
          [view.briefing.ambient?.inProgress, "in-progress"],
        ] as const) {
          for (const line of run?.lines ?? []) {
            expect(line.count).toBe(line.itemIds.length);
            for (const id of line.itemIds) {
              expect(tiersById.get(id), id).toBe("ambient");
              home(id, label);
            }
          }
        }
        // Place figures can share membership; their union is the Background home.
        const counted = new Set(view.briefing.places?.flatMap((place) => place.itemIds));
        const onCards = new Set([
          ...cardsOf(view).flatMap((card) => card.itemIds),
          ...(view.briefing.horizon.owed?.itemIds ?? []),
        ]);
        for (const item of expected) {
          if (item.attention === "background" && counted.has(item.id) && !onCards.has(item.id)) {
            home(item.id, "places");
          }
        }
        for (const entry of view.briefing.canWait?.items ?? []) {
          for (const id of entry.itemIds) {
            expect(tiersById.get(id), id).toBe("background");
            expect(counted.has(id), id).toBe(false);
            home(id, "can-wait");
          }
        }
        const surface = expected.filter((i) => i.attention === "surface");
        expect(expected.filter((i) => !homes.has(i.id))).toEqual([]);
        for (const item of expected) {
          expect(homes.get(item.id), item.id).toHaveLength(1);
          if (item.attention === "surface") {
            const where = homes.get(item.id)?.[0] ?? "";
            expect(where.startsWith("decision:"), item.id).toBe(item.origin === "system");
          }
        }
        expect(view.briefing.decisions?.items).toBe(
          surface.filter((i) => i.origin === "system").length,
        );
      });
    }
  }

  it("keeps snapshot-1106's rollout and release-red Surface items in Decisions waiting", () => {
    const view = projectWatch(recordedInput());
    const decisions = view.briefing.decisions?.groups.flatMap((group) => group.itemIds);
    for (const id of ["rollout", "release-red:Azure/osdu-spi-entitlements#89"]) {
      expect(itemsOf(view).find((item) => item.id === id)?.attention).toBe("surface");
      expect(decisions).toContain(id);
      expect(view.briefing.ambient?.inProgress.lines.flatMap((line) => line.itemIds)).not.toContain(
        id,
      );
    }
  });

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
      const place = upstreamReading(view)
        .items.flatMap((i) => i.ids)
        .sort();
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

describe("R3 homes for upstream work", () => {
  it("gives each unjoined Surface sync PR an unknown Review card, never a guessed change", () => {
    const view = projectWatch(recordedInput());
    for (const service of ["indexer", "indexer-queue"]) {
      const id = `gate1:${service}`;
      const homes = cardsOf(view).filter((c) => c.itemIds.includes(id));
      expect(homes).toHaveLength(1);
      expect(homes[0]).toMatchObject({
        id: `sync:${id}`,
        kind: "sync",
        token: "Sync upstream",
        services: [{ service, stage: "unknown", pr: { inspect: id } }],
        itemIds: [id],
        needsYou: true,
        verb: "Review",
      });
      expect(homes[0]?.services[0]?.pr?.number).toBeGreaterThan(0);
      expect(homes[0]?.text).toContain("Review");
    }
    expect(card(view, "os-core-common 8.5.0").itemIds).not.toContain("gate1:indexer");
  });

  it("keeps an unproven sync stage distinct from an unread fork", () => {
    const input = recordedInput();
    const now = input.context.clock.now();
    const model = buildModel(input.facts, now, {}, input.context);
    const briefing = buildBriefing(model, input.doctor, now, input.context);
    const build = (unread: string[]) =>
      horizonCards({ model, items: tiered(input), themes: briefing.themes, unread }).cards.find(
        (card) => card.id === "sync:gate1:indexer",
      );
    const read = build([]);
    expect(read?.services).toMatchObject([{ service: "indexer", stage: "unknown" }]);
    expect(read?.text).toContain("stage not proven on indexer");
    expect(read?.text).not.toContain("Not fully read");
    expect(build(["indexer"])?.text).toMatch(/Not fully read on indexer\.$/);
  });

  it("joins legal's proven PR to its halt card and carries the Interrupt mark", () => {
    const input = badInput();
    const pr = input.facts.github.data?.repos["Azure/osdu-spi-legal"]?.prs.find(
      (p) => p.number === 701,
    );
    const target = input.facts.upstream.data?.legal?.commits.at(-1)?.sha;
    if (!pr || !target) throw new Error("No legal sync target");
    pr.title = `Sync upstream ${target}`;
    const view = projectWatch(input);
    const homes = cardsOf(view).filter((c) => c.itemIds.includes("gate1:legal"));
    expect(homes).toHaveLength(1);
    expect(homes[0]).toMatchObject({
      kind: "halt",
      token: "schemathesis-tests",
      needsYou: true,
      mark: "stopped",
      services: [{ service: "legal", stage: "wont-land", pr: { inspect: "gate1:legal" } }],
    });
    expect(itemsOf(view).find((i) => i.id === "gate1:legal")?.attention).toBe("interrupt");
    expect(upstreamReading(view).items.flatMap((i) => i.ids)).toContain("gate1:legal");
  });

  it.each(["partial", "unread", "different PR"] as const)(
    "does not join legal's PR when its held change is %s",
    (proof) => {
      const input = badInput();
      const now = input.context.clock.now();
      const model = buildModel(input.facts, now, {}, input.context);
      const fork = model.upstream.forks.find((f) => f.service === "legal");
      if (!fork?.syncPr || !fork.behind) throw new Error("No legal sync PR");
      fork.syncPr.holds = fork.behind;
      if (proof === "partial") fork.syncPr.holds = fork.behind - 1;
      if (proof === "unread") delete fork.syncPr.holds;
      if (proof === "different PR") fork.syncPr.url += "?different";
      const briefing = buildBriefing(model, input.doctor, now, input.context);
      const items = tiered(input);
      const { cards } = horizonCards({ model, items, themes: briefing.themes });
      expect(cards.find((c) => c.kind === "halt")?.itemIds).not.toContain("gate1:legal");
      expect(cards.filter((c) => c.itemIds.includes("gate1:legal"))).toMatchObject([
        { kind: "sync", mark: "stopped", services: [{ stage: "unknown" }] },
      ]);
    },
  );

  it("does not attach a PR to a change named only in a possible upstream MR", () => {
    const input = badInput();
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    const fork = model.upstream.forks.find((f) => f.service === "legal");
    if (!fork?.syncPr || !fork.behind) throw new Error("No legal sync PR");
    fork.syncPr.holds = fork.behind;
    model.queue.items = model.queue.items.filter((q) => q.id === "gate1:legal");
    const { cards } = horizonCards({
      model,
      items: tiered(input).filter((i) => i.id === "gate1:legal"),
      themes: [
        {
          id: "toolchain:future",
          kind: "toolchain",
          title: "Future toolchain",
          certain: [],
          possible: [{ fork: "legal", state: "open" }],
          sub: "An open upstream MR may change legal.",
          exposed: [],
          tone: "neutral",
          next: "",
        },
      ],
    });
    expect(cards.find((c) => c.id === "toolchain:future")?.itemIds).toEqual([]);
    expect(cards.filter((c) => c.itemIds.includes("gate1:legal"))).toMatchObject([
      { kind: "sync", services: [{ stage: "unknown" }] },
    ]);
  });

  for (const [name, make] of RECORDED) {
    it(`gives ports only the owed home and counts every card once on ${name}`, () => {
      const input = make();
      const view = projectWatch(input);
      const expected = tiered(input);
      const ports = expected.filter((item) => item.ids.some((id) => id.startsWith("port:")));
      const owed = view.briefing.horizon.owed;
      expect(owed?.itemIds).toEqual(ports.map((item) => item.id));
      const otherHomes = [
        ...cardsOf(view).flatMap((c) => c.itemIds),
        ...(view.briefing.ambient?.inProgress.lines.flatMap((line) => line.itemIds) ?? []),
        ...(view.briefing.ambient?.failing.lines.flatMap((line) => line.itemIds) ?? []),
        ...(view.briefing.canWait?.items.flatMap((entry) => entry.itemIds) ?? []),
      ];
      for (const item of ports) expect(otherHomes).not.toContain(item.id);
      expect(owed?.count).toBe(owed?.services.reduce((sum, f) => sum + f.count, 0));
      const clause = view.briefing.verdict?.text.match(/(\d+) upstream changes? need/);
      if (
        !expected.some((i) => i.origin === "upstream" && i.attention === "interrupt") &&
        (view.briefing.horizon.counts?.needYouCards ?? 0) > 0
      ) {
        expect(clause).not.toBeNull();
        expect(Number(clause?.[1])).toBe(view.briefing.horizon.counts?.needYouCards);
      }
      const ids = upstreamReading(view).items.flatMap((item) => item.ids);
      expect(new Set(ids).size).toBe(ids.length);
    });
  }
});
