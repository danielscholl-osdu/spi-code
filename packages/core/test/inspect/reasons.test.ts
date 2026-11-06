// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { ActionItem } from "../../src/act/action-item.js";
import { reasonSources } from "../../src/act/reason-sources.js";
import { createContext } from "../../src/context.js";
import type { AreaName } from "../../src/facts.js";
import { approvalSection, type InspectOptions, verbsOf } from "../../src/inspect/actions.js";
import { buildModel, type Model } from "../../src/model/index.js";
import type { QueueItem } from "../../src/model/queue.js";
import { fixtureContext } from "../briefing-setup.js";
import { FIXTURE_NOW, fixtureFacts, laneFacts } from "../harness.js";

const context = createContext({ ...fixtureContext, clock: { now: () => FIXTURE_NOW } });
const models = {
  fixture: buildModel(fixtureFacts(), FIXTURE_NOW, {}, context),
  lanes: buildModel(laneFacts(), FIXTURE_NOW, {}, context),
  down: buildModel(laneFacts(true), FIXTURE_NOW, {}, context),
};
const {
  cases,
}: {
  cases: { name: string; fixture: keyof typeof models; item: QueueItem; opts: InspectOptions }[];
} = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/rib-59d6895/oracle/inspect-actions.json", import.meta.url),
    "utf8",
  ),
);

function actions(item: QueueItem, model: Model, opts: InspectOptions): ActionItem[] {
  return [
    ...verbsOf(item, model, context, opts),
    ...(approvalSection(item, model, opts)?.items.flatMap((i) => i.actions) ?? []),
  ];
}
function sources(name: string, model?: Partial<Model>, opts?: InspectOptions) {
  const c = cases.find((x) => x.name === name);
  if (!c) throw new Error(`no oracle case ${name}`);
  return actions(c.item, { ...models[c.fixture], ...model }, opts ?? c.opts).map((a) => [
    a.reason,
    reasonSources(a),
  ]);
}

describe("action reasons carry the Facts areas they were read from", () => {
  test("every reason on the recorded cases has its sources, and an enabled action has none", () => {
    for (const c of cases) {
      for (const a of actions(c.item, models[c.fixture], c.opts)) {
        expect(reasonSources(a) === undefined, `${c.name}: ${a.label}`).toBe(
          a.reason === undefined,
        );
      }
    }
  });

  test.each<[string, AreaName[]]>([
    ["busy lifecycle", ["lifecycle"]],
    ["template actions", ["github", "template"]],
  ])("%s cites the areas behind its first reason", (name, areas) => {
    expect(sources(name)[0]?.[1]).toEqual(areas);
  });

  test("a rollout held red on the stack cites the PR checks and their job details", () => {
    expect(sources("template actions")[1]).toEqual([
      expect.stringContaining("are red on the stack"),
      ["github", "details"],
    ]);
  });

  test.each(["scope blocked", "no durable ops", "already waiting", "approval scope blocked"])(
    "%s rests on host state alone and cites no area",
    (name) => {
      const all = sources(name);
      expect(all.length).toBeGreaterThan(0);
      for (const [reason, from] of all) {
        expect(reason).toBeDefined();
        expect(from).toEqual([]);
      }
    },
  );

  test("a missing sweep cites no area, even where the facts would", () => {
    for (const name of ["busy lifecycle", "template actions", "approval waiting"]) {
      for (const [reason, from] of sources(name, { sweptAt: undefined })) {
        expect(reason).toBe("no sweep has read GitHub yet");
        expect(from).toEqual([]);
      }
    }
  });

  test("a full lane cap cites what it counted, and an unread one the area still unread", () => {
    const lanes = cases.find((c) => c.name === "deployable lanes");
    const repos = (lanes?.item.lanes ?? []).map((l) => ({
      repo: l.repo,
      service: l.service,
      what: "x",
    }));
    expect(sources("deployable lanes", { lanes: { cap: 1, inflight: repos } })).toEqual([
      [expect.stringContaining("lanes in flight"), ["github", "runs"]],
    ]);
    for (const [unread, areas] of [
      ["fork workflow runs", ["runs"]],
      ["PR checks", ["github"]],
    ] as const) {
      expect(sources("deployable lanes", { lanes: { cap: 2, inflight: [], unread } })).toEqual([
        [`lanes unknown until ${unread} are read`, areas],
      ]);
    }
  });

  test("a stop-the-line judgement cites the failed checks and their job details", () => {
    const c = cases.find((x) => x.name === "deployable lanes");
    if (!c) throw new Error("no deployable lanes case");
    const item = {
      ...c.item,
      judgement: { response: "stop", note: "same test twice" },
    } as QueueItem;
    const [action] = actions(item, models.lanes, c.opts);
    expect(action?.reason).toMatch(/^stop the line/);
    expect(reasonSources(action as ActionItem)).toEqual(["github", "details"]);
    const [scoped] = actions(item, models.lanes, { scopes: [] });
    expect(reasonSources(scoped as ActionItem)).toEqual([]);
  });
});
