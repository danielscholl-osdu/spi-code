// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { buildBriefing } from "../src/brief/index.js";
import { verbsOf } from "../src/inspect/actions.js";
import { buildModel } from "../src/model/index.js";
import { stationSubstateOf } from "../src/model/substate.js";
import { environmentReading } from "../src/readings/environment.js";
import { fixtureContext } from "./briefing-setup.js";
import { FIXTURE_NOW, laneFacts } from "./harness.js";

function mixedLanes() {
  const facts = laneFacts();
  for (const fork of fixtureContext.fleet.forks) {
    const repo = facts.github.data?.repos[fork.repo];
    if (!repo) throw new Error(`missing ${fork.repo}`);
    if (fork.id !== "partition") repo.prs = [];
    repo.deployments = [
      {
        createdAt: "2026-10-12T21:00:00Z",
        statusAt: "2026-10-12T21:15:00Z",
        ref: "main",
        sha: `latest-${fork.id}`,
        state: fork.id === "entitlements" ? "FAILURE" : fork.id === "legal" ? "ERROR" : "SUCCESS",
      },
    ];
  }
  facts.runs.data = {};
  return facts;
}

function project(facts = mixedLanes()) {
  const model = buildModel(facts, FIXTURE_NOW, {}, fixtureContext);
  const brief = buildBriefing(model, { state: "clear", problems: [] }, FIXTURE_NOW, fixtureContext);
  const items = [...brief.focus, ...brief.rest];
  const reading = environmentReading({
    model,
    items,
    facts,
    lifecycle: [],
    reads: [],
    stackRepo: fixtureContext.stackRepo,
    now: FIXTURE_NOW,
  });
  return { facts, model, items, reading };
}

describe("lane deployment failures beside recovered environment checks", () => {
  test("every stopped fork has its deployment item in the brief and Environment", () => {
    const { facts, model, items, reading } = project();
    expect(model.stack.deployable.state).toBe("yes");
    const stopped = model.lines
      .filter((line) => {
        const station = line.stations.find((s) => s.id === "lane");
        return station && stationSubstateOf(station, line, facts) === "stopped";
      })
      .map((line) => line.fork.id);
    expect(stopped).toEqual(["entitlements", "legal"]);
    expect(reading.tiles[1]).toEqual({
      label: "Lane",
      value: "Stopped",
      counts: "fork lanes · entitlements and legal · newest deploy passed on 3 of 5",
    });
    const deployments = model.queue.items.filter((i) => i.kind === "lane-deploy");
    expect(deployments.map((i) => i.cause.find((f) => f.label === "fork")?.value).sort()).toEqual(
      [...stopped].sort(),
    );
    const laneBrief = buildBriefing(
      { ...model, queue: { ...model.queue, items: deployments } },
      { state: "clear", problems: [] },
      FIXTURE_NOW,
      fixtureContext,
    );
    expect(laneBrief.headline).toBe(
      "Investigate the entitlements lane. Investigate the legal lane.",
    );
    for (const fork of stopped) {
      const item = deployments.find((i) => i.id === `lane-deploy:${fork}`);
      expect(item).toBeDefined();
      expect(items.find((i) => i.id === item?.id)).toMatchObject({
        scope: "Environment",
        title: `Last lane deploy failed on ${fork}`,
        verb: "Investigate",
      });
      expect(reading.items.some((i) => i.id === item?.id)).toBe(true);
      if (!item) throw new Error("missing deployment item");
      expect(item.cls).toBe("UNREAD");
      expect(item.lanes).toBeUndefined();
      expect(verbsOf(item, model, fixtureContext)).toEqual([]);
    }
    const recovered = model.queue.items.find((i) => i.id === "stack:lanes");
    expect(recovered?.effects).toHaveLength(1);
    expect(recovered?.effects[0]?.text).toContain("partition template-sync PR");
    expect(recovered?.lanes?.map((l) => l.service)).toEqual(["partition"]);
  });

  test("a later successful deployment clears only that fork's failed deployment item", () => {
    const facts = mixedLanes();
    const repo = facts.github.data?.repos["Azure/osdu-spi-entitlements"];
    if (!repo) throw new Error("missing entitlements");
    repo.deployments.unshift({
      createdAt: "2026-10-12T21:30:00Z",
      state: "SUCCESS",
      ref: "main",
      sha: "recovered",
    });
    const { items, reading } = project(facts);
    expect(items.some((i) => i.id === "lane-deploy:entitlements")).toBe(false);
    expect(items.some((i) => i.id === "lane-deploy:legal")).toBe(true);
    expect(reading.tiles[1]?.counts).toBe("fork lanes · legal · newest deploy passed on 4 of 5");
  });

  test("a deployment already explained by the same head's ENV check keeps its existing item", () => {
    const { model } = project(laneFacts());
    expect(model.queue.items.filter((i) => i.kind === "lane-deploy")).toEqual([]);
    expect(model.queue.items.find((i) => i.id === "stack:lanes")?.lanes).toHaveLength(5);
  });
});
