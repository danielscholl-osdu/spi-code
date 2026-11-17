// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
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
  const stopped = model.lines
    .filter((line) =>
      line.stations.some(
        (station) => station.id !== "lane" && stationSubstateOf(station, line, facts) === "stopped",
      ),
    )
    .map((line) => line.fork.id);
  return { model, stopped };
}

describe("stopped forks", () => {
  test("counts a failed Sync Upstream and a red main once each, as the strip does", () => {
    const facts = greenFacts();
    const sync = facts.runs.data?.["Azure/osdu-spi-storage"]?.sync[0];
    const main = facts.runs.data?.["Azure/osdu-spi-indexer-queue"]?.main[0];
    if (!sync || !main) throw new Error("Missing recorded workflow runs");
    sync.conclusion = "failure";
    main.conclusion = "failure";
    const { model, stopped } = reading(facts);
    expect(model.lines.find(({ fork }) => fork.id === "storage")?.syncRun?.conclusion).toBe(
      "failure",
    );
    expect(stopped).toEqual(["storage", "indexer-queue"]);
    expect(model.stoppedForks).toEqual(stopped);
  });

  test("names no fork when no line station is stopped", () => {
    const { model, stopped } = reading(greenFacts());
    expect(stopped).toEqual([]);
    expect(model.stoppedForks).toEqual([]);
  });

  test("a failed sync alone stops its fork", () => {
    const facts = greenFacts();
    const sync = facts.runs.data?.["Azure/osdu-spi-storage"]?.sync[0];
    if (!sync) throw new Error("Missing recorded Sync Upstream run");
    sync.conclusion = "failure";
    const { model, stopped } = reading(facts);
    expect(stopped).toEqual(["storage"]);
    expect(model.stoppedForks).toEqual(["storage"]);
  });
});
