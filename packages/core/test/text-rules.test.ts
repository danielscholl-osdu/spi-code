// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBriefing } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import { buildModel } from "../src/model/index.js";
import {
  internalNames,
  readingText,
  serviceReading,
  upstreamReading,
  wordCount,
} from "../src/readings/index.js";
import { parseRollout } from "../src/rollout.js";
import { UPSTREAM_NOW, UPSTREAM_SERVICES, UPSTREAM_STATES } from "./upstream-states.js";

const root = fileURLToPath(new URL("../../../fixtures/watch/", import.meta.url));
const fixtures = readdirSync(root)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, body: JSON.parse(readFileSync(`${root}${name}`, "utf8")) as unknown }));

// Fields the window draws only in Detail or as read evidence.
const DETAIL = new Set(["detail", "evidence", "envelope", "reads", "provenance"]);
// Identifiers and enums, never drawn as copy.
const KEYS = new Set(["id", "ids", "inspect", "kind"]);

type Leaf = { path: string; text: string; detail: boolean };

function leaves(value: unknown, path: string[] = [], detail = false): Leaf[] {
  if (typeof value === "string") return [{ path: `/${path.join("/")}`, text: value, detail }];
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, [...path, String(i)], detail));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, v]) =>
      KEYS.has(key) ? [] : leaves(v, [...path, key], detail || DETAIL.has(key)),
    );
  return [];
}

// The only briefing paths the window draws in Detail or Evidence; every other string is drawn copy.
const BRIEFING_DETAIL = [
  /^\/(focus|rest)\/\d+\/evidence\//,
  /^\/flow\/rows\/\d+\/detail\//,
  /^\/environment\/lanes\/\d+\/events\/\d+\/detail(\/|$)/,
];

function drawnBriefing(briefing: unknown): Leaf[] {
  return leaves(briefing)
    .filter((leaf) => !BRIEFING_DETAIL.some((pattern) => pattern.test(leaf.path)))
    .map((leaf) => ({ ...leaf, path: `/briefing${leaf.path}`, detail: false }));
}

function named(drawn: readonly { path: string; text: string }[]) {
  return drawn
    .filter((leaf) => internalNames(leaf.text).length > 0)
    .map(({ path, text }) => ({ path, text }));
}

describe.each(fixtures)("the text rules on $name", ({ name, body }) => {
  // An inspect fixture is a Detail panel through and through.
  const all = leaves(body, [], name.startsWith("inspect-"));
  const headlines = all.filter((leaf) => leaf.path.endsWith("/headline"));

  it("keeps every headline to at most 12 words", () => {
    if (!name.startsWith("inspect-")) expect(headlines.length).toBeGreaterThan(0);
    expect(
      headlines
        .filter((leaf) => wordCount(leaf.text) > 12)
        .map(({ path, text }) => ({ path, text })),
    ).toEqual([]);
  });

  it("keeps internal names in Detail and Evidence", () => {
    expect(named(all.filter((leaf) => !leaf.detail))).toEqual([]);
  });

  const briefing = (body as { briefing?: unknown }).briefing;
  it.runIf(briefing !== undefined)(
    "keeps internal names out of every drawn briefing string",
    () => {
      const drawn = drawnBriefing(briefing);
      expect(drawn.length).toBeGreaterThan(0);
      expect(named(drawn)).toEqual([]);
    },
  );
});

// The upstream states drive every station branch and the list-built headlines past their length.
const fleet = fleetOf(builtInFleet(UPSTREAM_SERVICES));
const states = Object.entries(UPSTREAM_STATES).map(([name, make]) => {
  const facts = make();
  const context = createContext({
    fleet,
    rollout: parseRollout(facts.fleet.data?.rollout as string).rollout,
  });
  const model = buildModel(facts, UPSTREAM_NOW, {}, context);
  const briefing = buildBriefing(model, { state: "clear", problems: [] }, UPSTREAM_NOW, context);
  const items = [...briefing.focus, ...briefing.rest];
  const readings = [
    upstreamReading({ model, items, radar: [], fleet: context.fleet, campaigns: [] }),
    ...model.lines.map((line) =>
      serviceReading({ model, service: line.fork.id, items, reads: [], now: UPSTREAM_NOW }),
    ),
  ].filter((r) => r !== null);
  return { name, model, briefing, readings };
});

describe.each(states)("the text rules on the $name state", ({ model, briefing, readings }) => {
  const stations = model.lines.flatMap((line) =>
    line.stations.map((s) => ({ path: `${line.fork.id}/${s.id}`, text: s.text })),
  );
  const shown = readings.flatMap((r) => readingText(r).map((text) => ({ path: "reading", text })));
  const headlines = [
    ...leaves(briefing).filter((leaf) => leaf.path.endsWith("/headline")),
    ...readings.map((r) => ({ path: "reading/headline", text: r.headline })),
  ];

  it("keeps every headline to at most 12 words", () => {
    expect(
      headlines
        .filter((leaf) => wordCount(leaf.text) > 12)
        .map(({ path, text }) => ({ path, text })),
    ).toEqual([]);
  });

  it("keeps internal names out of station text and readings", () => {
    expect(named([...stations, ...shown])).toEqual([]);
  });

  it("keeps internal names out of every drawn briefing string", () => {
    const drawn = drawnBriefing(briefing);
    expect(drawn.length).toBeGreaterThan(0);
    expect(named(drawn)).toEqual([]);
  });
});
