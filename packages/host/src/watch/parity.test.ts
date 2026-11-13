// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { InspectResult, ViewSnapshot } from "@spi-code/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import {
  briefingHolds,
  detailFeedIds,
  recordedDetailAnswers,
} from "../../test/watch/detail-feed.js";
import { detailFeedPath, recordedSnapshotPath } from "../../test/watch/snapshot-fixture.js";

process.env.TZ = "UTC";

/**
 * The window's Detail draws what inspect.request answers. These checks hold that answer to the
 * recorded snapshot: a briefing value the window sends to Detail must come back unchanged after the
 * sweep is persisted and served by the router. The window's reachability suite draws Detail from
 * fixtures/watch/inspect-1106.json, which must equal the router's answers field for field;
 * scripts/watch-snapshot.ts regenerates it through detail-feed.ts, the same path these checks ask.
 * Projection, the store's replay and the oracle comparisons live in project.test.ts,
 * snapshot-1106.test.ts and process/routes.test.ts.
 */
const snapshot: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));
const { briefing } = snapshot;
const queue = [...briefing.focus, ...briefing.rest];

/** Named gaps: each pointer names its bead, and the test fails once the gap closes. */
const GAPS: Readonly<Record<string, string>> = {
  "port-group": "spicode-t1k.216: a grouped port item's Detail shows its first fork",
};

const holds = briefingHolds(briefing);

const groupedPort = (item: (typeof queue)[number]) => item.cls === "PORT" && item.ids.length > 1;

let results: Map<string, InspectResult>;

beforeAll(async () => {
  results = await recordedDetailAnswers();
});

function answer(id: string): InspectResult {
  const result = results.get(id);
  if (!result) throw new Error(`No inspect.result for ${id}`);
  return result;
}

/** What the window's Detail draws from an answer: the inspector and its Related rows. */
function drawn({ actions: _a, areas: _r, provenance: _p, ...shown }: InspectResult) {
  return shown;
}

const overlaps = (hold: (typeof holds)[number]["event"], e: typeof hold) => {
  const end = (x: typeof hold) =>
    x.end === undefined ? Number.POSITIVE_INFINITY : Date.parse(x.end);
  return Date.parse(e.start) <= end(hold) && end(e) >= Date.parse(hold.start);
};

describe("Detail answers on the recorded 6 Nov sweep equal its briefing", () => {
  it.each(queue.map((item) => [item.id, item] as const))(
    "answers queue item %s with the briefing's class, cause, effect and next",
    (id, item) => {
      const result = answer(id);
      expect(result.id).toBe(id);
      expect(result.class).toBe(item.cls);
      expect(result.next).toBe(item.next);
      if (groupedPort(item)) {
        expect(GAPS["port-group"]).toBeDefined();
        expect([result.cause, result.effect]).not.toEqual([item.cause, item.effect]);
      } else {
        expect(result.cause).toBe(item.cause);
        expect(result.effect).toBe(item.effect);
      }
    },
  );

  it.each(briefing.themes.map((theme) => [theme.id, theme] as const))(
    "answers Horizon theme %s with its next step, every fork state and its queue item",
    (_id, theme) => {
      const result = answer(`theme:${theme.id}`);
      const related = result.related.map(({ state, text }) => `${state} | ${text}`);
      const forks = [
        ...theme.certain.map(({ fork, state }) => `certain · ${state} | ${fork}`),
        ...theme.possible.map(({ fork, state }) => `possible · ${state} | ${fork}`),
        ...theme.exposed.map((fork) => `exposed | ${fork}`),
      ];
      expect(result).toMatchObject({ cause: theme.title, effect: theme.sub, next: theme.next });
      expect(result.why).toBe(theme.when ?? "");
      const item = queue.find(({ id }) => id === theme.inspect);
      expect(related).toEqual([...forks, ...(item ? [`${item.cls} | ${item.title}`] : [])]);
      if (item)
        expect(result.related.at(-1)).toEqual({
          text: item.title,
          state: item.cls,
          inspect: item.id,
        });
    },
  );

  it.each(holds.map(({ id, event }) => [id, event] as const))(
    "answers hold %s with every field its Detail draws, Related runs in lane order",
    (id, event) => {
      const runs = briefing.environment.lanes
        .filter((lane) => lane.id !== "holds")
        .flatMap((lane) =>
          lane.events
            .filter((e) => overlaps(event, e))
            .map((e) => ({
              text: `${lane.label} ${e.label}`,
              state: e.detail,
              inspect: e.inspect ?? `run:${e.id}`,
            })),
        );
      expect(runs.length).toBeGreaterThan(0);
      expect(drawn(answer(id))).toEqual({
        id,
        title: `Held ${event.label}`,
        class: event.end === undefined ? "GATE" : "READY",
        cause: `Held ${event.label}`,
        effect: event.detail,
        next: "",
        why: event.end === undefined ? `since ${event.start}` : `${event.start} to ${event.end}`,
        evidence: [],
        related: runs,
        approval: null,
      });
    },
  );

  it("serves the Detail feed the window's reachability suite draws, field for field", () => {
    expect(detailFeedIds(briefing).map(answer)).toEqual(
      JSON.parse(readFileSync(detailFeedPath, "utf8")),
    );
  });
});
