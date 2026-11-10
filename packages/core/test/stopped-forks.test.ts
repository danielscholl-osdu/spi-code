// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { buildBriefing } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import { buildModel } from "../src/model/index.js";
import { stationSubstateOf } from "../src/model/substate.js";
import { UPSTREAM_NOW, UPSTREAM_SERVICES, upstreamFacts } from "./upstream-states.js";

const context = createContext({ fleet: fleetOf(builtInFleet(UPSTREAM_SERVICES)) });

function greenFacts() {
  const facts = upstreamFacts();
  for (const repo of Object.values(facts.github.data?.repos ?? {})) {
    repo.prs = [];
    repo.issues = [];
  }
  for (const runs of Object.values(facts.runs.data ?? {})) {
    for (const lane of [runs.sync, runs.template, runs.cascade, runs.main]) {
      for (const run of lane) {
        run.status = "completed";
        run.conclusion = "success";
      }
    }
  }
  for (const compare of Object.values(facts.template.data?.compares ?? {})) compare.aheadBy = 0;
  facts.approvals.data = {};
  facts.details.data = {};
  return facts;
}

function reading(facts: ReturnType<typeof greenFacts>) {
  const model = buildModel(facts, UPSTREAM_NOW, {}, context);
  const briefing = buildBriefing(model, { state: "clear", problems: [] }, UPSTREAM_NOW, context);
  const stopped = model.lines
    .filter((line) =>
      line.stations.some(
        (station) => station.id !== "lane" && stationSubstateOf(station, line, facts) === "stopped",
      ),
    )
    .map((line) => line.fork.id);
  return { model, tile: briefing.facts.find(({ label }) => label === "Upstream sync"), stopped };
}

describe("Today's stopped forks", () => {
  test("counts a failed Sync Upstream and a red main once each, as the strip does", () => {
    const facts = greenFacts();
    const sync = facts.runs.data?.["Azure/osdu-spi-storage"]?.sync[0];
    const main = facts.runs.data?.["Azure/osdu-spi-indexer-queue"]?.main[0];
    if (!sync || !main) throw new Error("Missing recorded workflow runs");
    sync.conclusion = "failure";
    main.conclusion = "failure";
    const { model, tile, stopped } = reading(facts);
    expect(model.lines.find(({ fork }) => fork.id === "storage")?.syncRun?.conclusion).toBe(
      "failure",
    );
    expect(stopped).toEqual(["storage", "indexer-queue"]);
    expect(tile).toEqual({
      label: "Upstream sync",
      figure: "2 of 13",
      sub: "forks stopped · storage and indexer-queue",
      tone: "bad",
    });
    expect(tile?.sub).not.toContain("every sync flowing");
  });

  test("keeps every sync flowing when no line station is stopped", () => {
    const { tile, stopped } = reading(greenFacts());
    expect(stopped).toEqual([]);
    expect(tile).toEqual({
      label: "Upstream sync",
      figure: "0 of 13",
      sub: "forks stopped · every sync flowing",
      tone: "ok",
    });
  });

  test("a failed sync alone cannot read every sync flowing", () => {
    const facts = greenFacts();
    const sync = facts.runs.data?.["Azure/osdu-spi-storage"]?.sync[0];
    if (!sync) throw new Error("Missing recorded Sync Upstream run");
    sync.conclusion = "failure";
    const { tile, stopped } = reading(facts);
    expect(stopped).toEqual(["storage"]);
    expect(tile).toMatchObject({
      figure: "1 of 13",
      sub: "forks stopped · storage",
      tone: "bad",
    });
  });
});
