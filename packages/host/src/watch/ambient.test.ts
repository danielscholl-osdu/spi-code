// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { buildBriefing, buildModel } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { ambientOf, canWaitOf } from "../../../core/src/brief/ambient.js";
import { projectWatch, type WatchInput } from "./project.js";
import { busyInput, calmInput } from "./snapshot-fixture.js";

function known(input: WatchInput): WatchInput {
  const now = input.context.clock.now();
  const model = buildModel(input.facts, now, {}, input.context);
  const briefing = buildBriefing(model, input.doctor, now, input.context);
  return {
    ...input,
    attention: {
      leadTimeMs: 0,
      previous: [...briefing.focus, ...briefing.rest].map((item) => ({
        ...item,
        attention: "ambient",
        owned: false,
      })),
      previousThemes: briefing.themes.map((theme) => theme.id),
    },
  };
}

const itemsOf = (view: ReturnType<typeof projectWatch>) => [
  ...view.briefing.focus,
  ...view.briefing.rest,
];

describe("Ambient lines (PS-03, PS-19)", () => {
  it("folds a lane failure and its red gate check into one Failing line counting two items", () => {
    const view = projectWatch(known(busyInput()));
    expect(view.briefing.ambient?.failing).toMatchObject({
      items: 2,
      text: "2 in 1",
      lines: [
        {
          itemIds: ["stack:lanes", "gate2:indexer-queue"],
          count: 2,
          service: "indexer-queue",
          station: "cascade",
          pr: { number: 67, inspect: "gate2:indexer-queue" },
          state: { text: "Verify", tone: "bad" },
          followUp: "Re-run once the lanes drain.",
        },
      ],
    });
    const line = view.briefing.ambient?.failing.lines[0];
    expect(line?.text).toContain("release/upstream PR #67");
    expect(line?.text).toContain("Verify failed");
    expect(line?.text).toContain(line?.age);
    expect(line?.text).toContain("Re-run once the lanes drain.");
  });

  it("splits by class and current check state without changing tiers, preserving core order", () => {
    const input = known(busyInput());
    const repo = input.facts.github.data?.repos["Azure/osdu-spi-indexer-queue"];
    const pr = repo?.prs.find((pr) => pr.number === 67);
    if (!pr) throw new Error("Fixture lacks gate2");
    pr.checks = [];
    const view = projectWatch(input);
    const gate = itemsOf(view).find((item) => item.id === "gate2:indexer-queue");
    expect(gate?.attention).toBe("ambient");
    expect(view.briefing.ambient?.failing.lines).toEqual([]);
    expect(
      view.briefing.ambient?.inProgress.lines.find((line) => line.itemIds.includes(gate?.id ?? "")),
    ).toMatchObject({ state: { text: "not read yet", tone: "neutral" } });
    const inProgress = view.briefing.ambient?.inProgress;
    expect(inProgress).toBeDefined();
    const ids = inProgress?.lines.flatMap((line) => line.itemIds) ?? [];
    expect(ids).toEqual(
      itemsOf(view)
        .filter(
          (item) =>
            item.attention === "ambient" &&
            !view.briefing.horizon.cards?.some((card) => card.itemIds.includes(item.id)),
        )
        .map((item) => item.id),
    );
  });

  it("puts TEST in Failing and every other Ambient class in In progress without mutating items", () => {
    const input = busyInput();
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    const source = itemsOf(projectWatch(input))[0];
    if (!source) throw new Error("Fixture lacks items");
    const items = (["TEST", "ROLLOUT", "GATE", "PORT", "ENV"] as const).map((cls) => ({
      ...source,
      id: `synthetic:${cls}`,
      ids: [`synthetic:${cls}`],
      cls,
      attention: "ambient" as const,
    }));
    const before = structuredClone(items);
    const ambient = ambientOf({ model, items, cards: [], now: input.context.clock.now() });
    expect(ambient.failing.lines.flatMap((line) => line.itemIds)).toEqual(["synthetic:TEST"]);
    expect(ambient.inProgress.lines.flatMap((line) => line.itemIds)).toEqual([
      "synthetic:ROLLOUT",
      "synthetic:GATE",
      "synthetic:PORT",
      "synthetic:ENV",
    ]);
    expect(items).toEqual(before);
  });

  it("does not fold separate jobs or items whose evidence cannot prove a shared job", () => {
    const input = known(busyInput());
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    const items = itemsOf(projectWatch(input));
    const gate = model.queue.items.find((item) => item.id === "gate2:indexer-queue");
    if (!gate?.url) throw new Error("Fixture lacks gate2");
    for (const url of [
      "https://github.com/Azure/osdu-spi-indexer-queue/actions/runs/67/job/9999",
      gate.url,
    ]) {
      gate.cause = gate.cause.map((fact) => (fact.label === "check" ? { ...fact, url } : fact));
      const ambient = ambientOf({ model, items, cards: [], now: input.context.clock.now() });
      const lines = [...ambient.failing.lines, ...ambient.inProgress.lines];
      expect(lines.find((line) => line.itemIds.includes("gate2:indexer-queue"))?.count).toBe(1);
      expect(lines.find((line) => line.itemIds.includes("stack:lanes"))?.count).toBe(1);
    }
  });

  it("leaves sync PRs joined to horizon cards off In progress at their original tier", () => {
    const view = projectWatch(busyInput());
    const lines = view.briefing.ambient?.inProgress.lines;
    expect(lines).toBeDefined();
    for (const id of ["gate1:indexer", "gate1:workflow", "gate1:unit"]) {
      expect(itemsOf(view).find((item) => item.id === id)?.attention).toBe("ambient");
      expect(view.briefing.horizon.cards?.some((card) => card.itemIds.includes(id))).toBe(true);
      expect(lines?.flatMap((line) => line.itemIds)).not.toContain(id);
    }
  });

  it("gives an unjoined sync PR its upstream origin and the rollout only its next merges", () => {
    const input = known(busyInput());
    const radar = input.facts.radar.data?.services;
    if (!radar) throw new Error("Fixture lacks radar");
    delete radar.indexer;
    const view = projectWatch(input);
    expect(
      view.briefing.ambient?.inProgress.lines.find((line) =>
        line.itemIds.includes("gate1:indexer"),
      ),
    ).toMatchObject({
      origin: "upstream",
      service: "indexer",
      station: "sync",
      state: { text: "review" },
    });
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    const rollout = view.briefing.ambient?.inProgress.lines.find((line) =>
      line.itemIds.includes("rollout"),
    );
    expect(rollout?.next).toEqual(model.rollout?.mergeNext.map((fork) => fork.service));
    expect(rollout?.text).not.toMatch(/of 13|lanes busy/);
  });
});

describe("Can wait (PS-03, PS-19)", () => {
  it("excludes every Background item a place row counts, including folded membership", () => {
    const input = busyInput();
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    const view = projectWatch(input);
    const items = itemsOf(view).map((item) => ({ ...item, attention: "background" as const }));
    const source = items[0];
    if (!source) throw new Error("Fixture lacks items");
    const waiting = {
      ...source,
      id: "background:unlisted",
      ids: ["background:unlisted"],
      title: "Routine work",
      next: "Watch the next sweep.",
    };
    items.push(waiting);
    const counted = new Set(view.briefing.places?.flatMap((place) => place.itemIds));
    const cards = view.briefing.horizon.cards ?? [];
    const cardIds = new Set(cards.flatMap((card) => card.itemIds));
    const result = canWaitOf({
      model,
      items,
      places: view.briefing.places ?? [],
      cards,
      reads: input.reads,
    });
    expect(result.items.flatMap((item) => item.itemIds)).toEqual(
      items
        .filter(
          (item) =>
            !counted.has(item.id) &&
            !cardIds.has(item.id) &&
            !item.ids.some((id) => counted.has(id) || cardIds.has(id)),
        )
        .map((item) => item.id),
    );
    expect(result.chips).toContainEqual({ text: "Routine work", count: 1 });
    expect(result.items.find((item) => item.id === waiting.id)?.why).toBe(
      "No action is due today. Watch the next sweep.",
    );
    const folded = canWaitOf({
      model,
      items: [waiting],
      places: [{ itemIds: ["part:counted"] }],
      cards: [],
      reads: input.reads,
    });
    expect(folded.items.flatMap((item) => item.itemIds)).toContain(waiting.id);
    waiting.ids.push("part:counted");
    expect(
      canWaitOf({
        model,
        items: [waiting],
        places: [{ itemIds: ["part:counted"] }],
        cards: [],
        reads: input.reads,
      }).items.flatMap((item) => item.itemIds),
    ).toEqual([]);
  });

  it("lists services only when no sync, gate or release waits", () => {
    const view = projectWatch(calmInput());
    const services = view.briefing.canWait?.items.filter((item) => item.service);
    expect(services?.map((item) => item.service)).toContain("file");
    expect(services?.every((item) => item.why === "no sync, gate or release waiting")).toBe(true);
    const busy = projectWatch(busyInput());
    expect(busy.briefing.canWait).toBeDefined();
    expect(busy.briefing.canWait?.items.map((item) => item.service)).not.toContain("file");
  });

  it("uses collected per-service records and the shared template read", () => {
    const input = calmInput();
    const at = input.context.clock.now().toISOString();
    const complete = { observedAt: at, completeness: { kind: "complete" as const } };
    const reads = {
      github: [{ ...complete, source: "github", object: "Azure/osdu-spi-file" }],
      runs: [{ ...complete, source: "Azure/osdu-spi-file", object: "fork-runs" }],
      upstream: [
        { ...complete, source: "osdu/platform/system/file", object: "repository/branches/master" },
      ],
      template: [{ ...complete, source: "Azure/osdu-spi", object: "compare/main" }],
    };
    const result = projectWatch({ ...input, envelopeReads: reads }).briefing.canWait;
    expect(result?.items.map((item) => item.service)).toEqual(["file"]);
  });

  it("does not list a service while a sync is running or its gate state is unproven", () => {
    for (const state of [
      "running",
      "missing-sync",
      "missing-template",
      "missing-upstream",
    ] as const) {
      const input = calmInput();
      const runs = input.facts.runs.data?.["Azure/osdu-spi-file"];
      if (!runs?.sync[0]) throw new Error("Fixture lacks file sync");
      if (state === "running") {
        runs.sync[0].status = "in_progress";
        delete runs.sync[0].conclusion;
      }
      if (state === "missing-sync") runs.sync = [];
      if (state === "missing-template") input.facts.template = {};
      if (state === "missing-upstream") delete input.facts.upstream.data?.file;
      const result = projectWatch(input).briefing.canWait;
      expect(result).toBeDefined();
      expect(
        result?.items.map((item) => item.service),
        state,
      ).not.toContain("file");
    }
  });

  for (const area of ["github", "runs", "upstream", "template"] as const) {
    it(`does not claim nothing waiting when ${area} was unread, failed or cut`, () => {
      for (const state of ["unread", "failed", "cut"] as const) {
        const input = calmInput();
        const records = input.reads[area] ?? [];
        const reads =
          state === "unread"
            ? []
            : records.map((record) => ({
                ...record,
                ...(state === "failed"
                  ? { failure: "Unavailable" }
                  : {
                      completeness: { kind: "cut" as const, reason: "limit", read: 1, total: 2 },
                    }),
              }));
        const view = projectWatch({ ...input, envelopeReads: { ...input.reads, [area]: reads } });
        expect(view.briefing.canWait).toBeDefined();
        expect(
          view.briefing.canWait?.items.filter((item) => item.service),
          state,
        ).toEqual([]);
      }
    });
  }
});
