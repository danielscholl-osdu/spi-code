// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { buildBriefing } from "../src/brief/index.js";
import { type CoreContext, createContext } from "../src/context.js";
import { verbsOf } from "../src/inspect/actions.js";
import { buildModel } from "../src/model/index.js";
import { stationSubstateOf } from "../src/model/substate.js";
import { environmentReading } from "../src/readings/environment.js";
import { serviceReading } from "../src/readings/index.js";
import { fixtureContext } from "./briefing-setup.js";
import { FIXTURE_NOW, fixtureFacts, laneFacts } from "./harness.js";

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

function project(facts = mixedLanes(), context: CoreContext = fixtureContext) {
  const model = buildModel(facts, FIXTURE_NOW, {}, context);
  const brief = buildBriefing(model, { state: "clear", problems: [] }, FIXTURE_NOW, context);
  const items = [...brief.focus, ...brief.rest];
  const reading = environmentReading({
    model,
    items,
    facts,
    lifecycle: [],
    reads: [],
    stackRepo: context.stackRepo,
    now: FIXTURE_NOW,
  });
  return { facts, model, items, reading };
}

describe("the re-run after the environment recovered lives with its fork in the app", () => {
  const partition = (p: ReturnType<typeof project>) =>
    serviceReading({
      model: p.model,
      service: "partition",
      items: p.items,
      reads: [],
      now: FIXTURE_NOW,
    });

  test("the app scopes it to the one fork, leads with the ask, and moves it off the Environment", () => {
    const app = project(mixedLanes(), createContext({ ...fixtureContext, words: "app" }));
    const item = app.items.find((i) => i.id === "stack:lanes");
    expect(item).toMatchObject({
      scope: "partition",
      title: "Re-run 1 check that failed on the environment",
    });
    expect(app.reading.items.some((i) => i.id === "stack:lanes")).toBe(false);
    expect(partition(app)?.items.some((i) => i.id === "stack:lanes")).toBe(true);
  });

  test("the boards keep it on the Environment in their words", () => {
    const boards = project();
    expect(boards.items.find((i) => i.id === "stack:lanes")).toMatchObject({
      scope: "Environment",
      title: "Deployable again",
    });
    expect(boards.reading.items.some((i) => i.id === "stack:lanes")).toBe(true);
    expect(partition(boards)?.items.some((i) => i.id === "stack:lanes")).toBe(false);
  });
});

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
      label: "Fork deploys",
      value: "2 failed",
      counts: "each fork's newest deploy to the environment · failed: entitlements and legal",
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
    expect(reading.tiles[1]).toMatchObject({
      value: "1 failed",
      counts: "each fork's newest deploy to the environment · failed: legal",
    });
  });

  test("a deployment already explained by the same head's ENV check keeps its existing item", () => {
    const { model } = project(laneFacts());
    expect(model.queue.items.filter((i) => i.kind === "lane-deploy")).toEqual([]);
    expect(model.queue.items.find((i) => i.id === "stack:lanes")?.lanes).toHaveLength(5);
  });

  test.each(["TEST", "UNREAD"] as const)(
    "a deployment explained by the same head's visible %s check keeps only the PR item",
    (cls) => {
      const facts = laneFacts();
      const repo = facts.github.data?.repos["Azure/osdu-spi-partition"];
      const pr = repo?.prs.find((p) => p.number === 174);
      const check = pr?.checks.find((c) => c.name === "Deploy and Test");
      const key = `${repo?.repo}#${check?.id}`;
      const detail = facts.details.data?.[key];
      if (!repo || !pr || !detail || !facts.details.data) throw new Error("partition #174");
      if (cls === "TEST") {
        facts.details.data[key] = {
          ...detail,
          failedStep: "Prove",
          reason: "2 acceptance tests failed",
        };
      } else delete facts.details.data[key];
      expect(repo.deployments.some((d) => d.sha === pr.headSha && d.state === "FAILURE")).toBe(
        true,
      );

      const { model, items } = project(facts);
      const failure = model.lines
        .find((l) => l.fork.id === "partition")
        ?.prs.find((p) => p.pr.number === 174)
        ?.failures.find((f) => f.check === "Deploy and Test");
      expect(failure).toMatchObject({ cls });
      expect(failure?.hidden).toBeFalsy();
      expect(model.queue.items.some((i) => i.id === "lane-deploy:partition")).toBe(false);
      expect(items.find((i) => i.id === "template-red:partition")).toMatchObject({
        title: "Template-sync PR #174 fails Deploy and Test",
      });
    },
  );

  test("the stack item explains failed deployments outside open PRs while the stack is down", () => {
    const facts = fixtureFacts();
    for (const fork of fixtureContext.fleet.forks) {
      const repo = facts.github.data?.repos[fork.repo];
      if (!repo) throw new Error(`missing ${fork.repo}`);
      repo.prs = [];
      repo.deployments = [
        {
          createdAt: "2026-10-12T21:00:00Z",
          state: "FAILURE",
          ref: "main",
          sha: `latest-${fork.id}`,
        },
      ];
    }

    const { model, items } = project(facts);
    expect(model.stack.deployable.state).toBe("no");
    for (const line of model.lines) {
      expect(line.stations.find((s) => s.id === "lane")).toMatchObject({
        state: "stopped",
        text: "blocked by the stack",
      });
    }
    expect(model.queue.items.filter((i) => i.kind === "lane-deploy")).toEqual([]);
    const stackItems = model.queue.items.filter((i) => i.kind === "stack");
    expect(stackItems).toHaveLength(1);
    expect(items.some((i) => i.id === stackItems[0]?.id)).toBe(true);
  });
});
