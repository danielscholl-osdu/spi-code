// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBriefing } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { type CoreContext, createContext } from "../src/context.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { buildModel, type Model } from "../src/model/index.js";
import { buildQueue } from "../src/model/queue.js";
import { dailySyncTime, stamp, timeClause } from "../src/util.js";
import "./utc.js";

const now = new Date("2026-11-06T14:02:00.133Z");
const fleet = fleetOf(
  builtInFleet(fileURLToPath(new URL("./fixtures/upstream-services.json", import.meta.url))),
);
const context = (timeStyle: CoreContext["timeStyle"] = "clock") =>
  createContext({
    fleet,
    timeStyle,
    clock: { now: () => now },
  });
const facts = (): Facts => ({
  ...emptyFacts(),
  ...JSON.parse(readFileSync(new URL("./fixtures/upstream-1106.json", import.meta.url), "utf8")),
});
const iso = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/g;

function noClocks(value: unknown) {
  const text = JSON.stringify(value).replace(iso, "instant");
  expect(text).not.toMatch(/\b\d{2}:\d{2}\b/);
  expect(text).not.toMatch(/Invalid Date|undefined|1970-01-01/);
}

function queue(model: Model, ctx: CoreContext) {
  return buildQueue(
    {
      ...model,
      repos: facts().github.data?.repos ?? {},
      details: {},
      approvals: {},
      now,
      forks: model.upstream.forks,
    },
    ctx,
  );
}

it("keeps every model-owned focus, rest and station time as an instant for the app", () => {
  const ctx = context("instant");
  const model = buildModel(facts(), now, {}, ctx);
  const briefing = buildBriefing(model, { state: "clear", problems: [] }, now, ctx);
  expect([...briefing.focus, ...briefing.rest].length).toBeGreaterThan(0);
  noClocks(model.queue.items);
  noClocks(model.lines.map(({ why, stations }) => ({ why, stations })));
  noClocks(
    model.rollout?.forks.map(({ validation, merge, main }) => ({ validation, merge, main })),
  );
  // Briefing composes its own effects and next-action copy.
  noClocks(
    [...briefing.focus, ...briefing.rest].map(({ title, sub, cause, evidence }) => ({
      title,
      sub,
      cause,
      evidence,
    })),
  );
});

function maintenance(ctx: CoreContext, since: string | undefined) {
  const model = buildModel(facts(), now, {}, ctx);
  const run = Object.values(facts().lifecycle.data ?? {}).flat()[0];
  if (!run) throw new Error("Recorded lifecycle run required");
  model.stack.maintenance = { state: "set", since, run };
  model.stack.attempts = [];
  delete model.stack.inflight;
  model.queue = queue(model, ctx);
  const item = model.queue.items.find(({ id }) => id === "stack:maintenance");
  if (!item) throw new Error("Synthetic maintenance must reach the queue");
  return { item, model };
}

function staleTemplate(ctx: CoreContext, at = "2026-11-01T12:00:00Z") {
  const input = facts();
  const fork = fleet.forks[0];
  if (!fork) throw new Error("Fleet required");
  const repo = input.github.data?.repos[fork.repo];
  const runs = input.runs.data?.[fork.repo];
  if (!repo || !runs?.template[0]) throw new Error("Recorded fork required");
  repo.prs = [];
  repo.issues = [];
  runs.main = [];
  runs.cascade = [];
  runs.template = [
    {
      ...runs.template[0],
      createdAt: at,
      status: "completed",
      conclusion: "success",
    },
  ];
  input.template.data = { ...input.template.data, compares: {} };
  return buildModel(input, now, {}, ctx).lines[0];
}

describe.each(["clock", "instant"] as const)("%s style", (style) => {
  const ctx = context(style);
  it("reaches the synthetic maintenance and stale-template branches", () => {
    const { item, model } = maintenance(ctx, "2026-11-06T13:00:00Z");
    const expected = style === "clock" ? "13:00" : "2026-11-06T13:00:00.000Z";
    expect(item.text).toBe(`maintenance held since ${expected} with no lifecycle run in flight`);
    const line = staleTemplate(ctx);
    expect(line?.pill.label).toBe("template stale");
    expect(line?.why).toBe(
      `Sync Template last ran ${style === "clock" ? "11-01 12:00" : "2026-11-01T12:00:00.000Z"}; it runs daily`,
    );
    if (style === "instant") {
      noClocks([item, line?.why]);
      const briefing = buildBriefing(model, { state: "clear", problems: [] }, now, ctx);
      noClocks(
        [...briefing.focus, ...briefing.rest].map(({ title, sub, cause, evidence }) => ({
          title,
          sub,
          cause,
          evidence,
        })),
      );
    }
    const behind = staleTemplate(ctx, now.toISOString());
    expect(behind?.why).toBe(
      `8 upstream commits not yet synced; the next daily sync runs${dailySyncTime(now, ctx)}`,
    );
  });

  it.each([undefined, "", "not-a-time"])(
    "omits an unknown maintenance time (%s) and its joining words",
    (at) => {
      const { item } = maintenance(ctx, at);
      expect(item.text).toBe("maintenance held with no lifecycle run in flight");
      expect(stamp(at, now, ctx)).toBeUndefined();
      expect(timeClause(at, now, ctx, " since ")).toBe("");
      expect(item.text).not.toMatch(/undefined|Invalid Date|1970|since/);
    },
  );
});

it("defaults to the existing text and gives the app only offset-bearing instants", () => {
  expect(createContext().timeStyle).toBe("clock");
  for (const at of ["2026-11-06T13:00:12Z", "2026-11-06T07:00:12-06:00", "2026-11-06T13:00:12"]) {
    expect(stamp(at, now)).toBe("13:00");
    expect(stamp(at, now, context())).toBe(stamp(at, now));
    expect(stamp(at, now, context("instant"))).toMatch(/(?:Z|[+-]\d{2}:\d{2})$/);
  }
  expect(dailySyncTime(now, context())).toBe(" at 00:00Z");
  expect(dailySyncTime(now, context("instant"))).toBe(" at 2026-11-07T00:00:00.000Z");
  expect(dailySyncTime(new Date("bad"), context("instant"))).toBe("");
});

it("preserves dismissal fingerprints when the app selects instant text", () => {
  const legacy = buildModel(facts(), now, {}, context()).queue.items;
  const app = buildModel(facts(), now, {}, context("instant")).queue.items;
  expect(app.map(({ id, fingerprint }) => ({ id, fingerprint }))).toEqual(
    legacy.map(({ id, fingerprint }) => ({ id, fingerprint })),
  );
});
