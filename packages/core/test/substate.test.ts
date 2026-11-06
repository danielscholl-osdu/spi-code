// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { builtInFleet, fleetOf } from "../src/config";
import { createContext } from "../src/context";
import type { Facts, PrFact, RunFact } from "../src/facts";
import { pendingChecks } from "../src/model/checks";
import { buildModel } from "../src/model/index";
import type { StationId } from "../src/model/lines";
import { stationSubstateOf } from "../src/model/substate";
import { FIXTURE_NOW, fixtureFacts } from "./harness";
import { fixtureContext } from "./model-fleet";
import { UPSTREAM_NOW, UPSTREAM_SERVICES, upstreamFacts } from "./upstream-states";

function substate(facts: Facts, id: StationId, service = "partition") {
  const line = buildModel(facts, FIXTURE_NOW, {}, fixtureContext).lines.find(
    (line) => line.fork.id === service,
  );
  const station = line?.stations.find((station) => station.id === id);
  if (!line || !station) throw new Error("Missing fixture station");
  return stationSubstateOf(station, line, facts);
}

function repo(facts: Facts) {
  const repo = facts.github.data?.repos["Azure/osdu-spi-partition"];
  if (!repo) throw new Error("Missing fixture repository");
  return repo;
}

function release(facts: Facts): PrFact {
  const recorded = facts.github.data?.repos["Azure/osdu-spi"]?.prs.find((pr) =>
    pr.head.startsWith("release-please--"),
  );
  if (!recorded) throw new Error("Missing recorded release PR");
  const pr = structuredClone(recorded);
  pr.repo = repo(facts).repo;
  repo(facts).prs.push(pr);
  return pr;
}

function run(facts: Facts, lane: "sync" | "cascade" | "main"): RunFact {
  const runs = facts.runs.data?.[repo(facts).repo];
  const recorded = runs?.[lane][0];
  if (!runs || !recorded) throw new Error("Missing recorded workflow run");
  const active = { ...recorded, status: "in_progress", conclusion: undefined };
  runs[lane].unshift(active);
  return active;
}

describe("typed station substates", () => {
  test("classifies recorded stops and quiet stations without reading their text", () => {
    const facts = fixtureFacts();
    expect(substate(facts, "sync", "entitlements")).toBe("stopped");
    expect(substate(facts, "upstream", "entitlements")).toBe("stopped");
    expect(substate(facts, "sync", "legal")).toBe("stopped");
    expect(substate(facts, "lane")).toBe("stopped");
    expect(substate(facts, "upstream")).toBe("ready");
    expect(substate(facts, "release")).toBe("ready");
    const line = buildModel(facts, FIXTURE_NOW, {}, fixtureContext).lines[0];
    if (!line) throw new Error("Missing fixture line");
    expect(
      stationSubstateOf({ id: "release", state: "idle", text: "waiting for review" }, line, facts),
    ).toBe("ready");
  });

  describe("lane validation substates", () => {
    const context = createContext({
      fleet: fleetOf(builtInFleet(UPSTREAM_SERVICES)),
      clock: { now: () => UPSTREAM_NOW },
    });

    function lane(facts: Facts, service: string) {
      const line = buildModel(facts, UPSTREAM_NOW, {}, context).lines.find(
        (line) => line.fork.id === service,
      );
      const station = line?.stations.find((station) => station.id === "lane");
      if (!line || !station) throw new Error("Missing recorded lane");
      return stationSubstateOf(station, line, facts);
    }

    test.each(["file", "schema", "partition"])(
      "%s keeps deploying despite a pending PR review or draft",
      (service) => {
        const facts = upstreamFacts();
        const pr = facts.github.data?.repos[`Azure/osdu-spi-${service}`]?.prs.find((pr) =>
          pendingChecks(pr).some((check) => check.workflow === "Validation"),
        );
        if (!pr) throw new Error("Missing recorded Validation PR");
        pr.reviewDecision = "REVIEW_REQUIRED";
        expect(lane(facts, service)).toBe("in-progress");
        pr.draft = true;
        expect(lane(facts, service)).toBe("in-progress");
      },
    );

    test("a lane waits for Validation approval, not PR review", () => {
      const facts = upstreamFacts();
      const repository = facts.github.data?.repos["Azure/osdu-spi-file"];
      const pr = repository?.prs.find((pr) =>
        pendingChecks(pr).some((check) => check.workflow === "Validation"),
      );
      const check = pr && pendingChecks(pr).find((check) => check.workflow === "Validation");
      const recordedRun = facts.runs.data?.["Azure/osdu-spi-file"]?.main[0];
      if (!repository || !pr || !check || !recordedRun) throw new Error("Missing recorded lane");
      check.status = "WAITING";
      expect(lane(facts, "file")).toBe("waiting-on-person");
      check.status = "IN_PROGRESS";
      facts.approvals.data = {
        [repository.repo]: [{ ...recordedRun, sha: pr.headSha }],
      };
      expect(lane(facts, "file")).toBe("waiting-on-person");
      facts.approvals.data[repository.repo] = [{ ...recordedRun, sha: "an older head" }];
      expect(lane(facts, "file")).toBe("in-progress");
    });

    function validating(facts: Facts, service: string): PrFact {
      const pr = facts.github.data?.repos[`Azure/osdu-spi-${service}`]?.prs.find((pr) =>
        pendingChecks(pr).some((check) => check.workflow === "Validation"),
      );
      if (!pr) throw new Error("Missing recorded Validation PR");
      return pr;
    }

    test.each(["file", "schema", "partition"])(
      "%s stops on a failed check or a merge conflict while Validation still runs",
      (service) => {
        const facts = upstreamFacts();
        const pr = validating(facts, service);
        expect(lane(facts, service)).toBe("in-progress");

        const check = pendingChecks(pr).find((check) => check.workflow === "Validation");
        if (!check) throw new Error("Missing recorded Validation check");
        pr.checks.push({
          ...check,
          name: "Code Quality",
          workflow: "Build",
          status: "COMPLETED",
          conclusion: "FAILURE",
        });
        expect(lane(facts, service)).toBe("stopped");
        check.status = "WAITING";
        expect(lane(facts, service)).toBe("stopped");

        const conflicted = upstreamFacts();
        validating(conflicted, service).mergeState = "DIRTY";
        expect(lane(conflicted, service)).toBe("stopped");
      },
    );
  });

  test("queued upstream work waits for the daily sync, not for a person", () => {
    const facts = fixtureFacts();
    const upstream = facts.upstream.data?.partition;
    if (!upstream) throw new Error("Missing recorded upstream");
    upstream.lag = 3;
    expect(substate(facts, "upstream")).toBe("waiting-on-clock");
    expect(substate(facts, "sync")).toBe("ready");
  });

  test("a recorded release review needs a person, including after approval until merge", () => {
    const facts = fixtureFacts();
    const pr = release(facts);
    expect(pr.reviewDecision).toBe("REVIEW_REQUIRED");
    expect(substate(facts, "release")).toBe("waiting-on-person");
    pr.reviewDecision = "APPROVED";
    expect(substate(facts, "release")).toBe("waiting-on-person");
  });

  test.each(["release", "sync", "main"] as const)(
    "%s PRs distinguish failed checks, checks running and human review",
    (id) => {
      const facts = fixtureFacts();
      const pr = release(facts);
      if (id === "sync") {
        pr.head = "sync/upstream-fixture";
        pr.base = "fork_upstream";
      } else if (id === "main") {
        pr.head = "release/upstream-fixture";
      }
      const check = pr.checks.find((check) => check.workflow);
      if (!check) throw new Error("Missing recorded workflow check");
      pr.reviewDecision = "APPROVED";
      check.status = "IN_PROGRESS";
      check.conclusion = undefined;
      expect(substate(facts, id)).toBe("in-progress");
      check.status = "COMPLETED";
      check.conclusion = "FAILURE";
      expect(substate(facts, id)).toBe("stopped");
      check.conclusion = "SUCCESS";
      pr.reviewDecision = "CHANGES_REQUESTED";
      expect(substate(facts, id)).toBe("waiting-on-person");
      pr.reviewDecision = "APPROVED";
      pr.mergeState = "DIRTY";
      expect(substate(facts, id)).toBe("stopped");
    },
  );

  test.each(["sync", "cascade", "main"] as const)(
    "%s runs distinguish execution from workflow approval",
    (id) => {
      const facts = fixtureFacts();
      const active = run(facts, id);
      expect(substate(facts, id)).toBe("in-progress");
      active.status = "waiting";
      expect(substate(facts, id)).toBe("waiting-on-person");
      active.status = "completed";
      active.conclusion = "action_required";
      expect(substate(facts, id)).toBe("waiting-on-person");
      active.status = "in_progress";
      active.conclusion = undefined;
      facts.approvals.data = { [repo(facts).repo]: [{ ...active }] };
      expect(substate(facts, id)).toBe("waiting-on-person");
    },
  );

  test("only a workflow approval for the PR's current head changes its station", () => {
    const facts = fixtureFacts();
    const pr = release(facts);
    pr.reviewDecision = "APPROVED";
    const active = run(facts, "main");
    const check = pr.checks.find((check) => check.workflow);
    if (!check) throw new Error("Missing recorded workflow check");
    check.status = "IN_PROGRESS";
    check.conclusion = undefined;
    facts.approvals.data = {
      [repo(facts).repo]: [{ ...active, sha: "an older head", pr: undefined }],
    };
    expect(substate(facts, "release")).toBe("in-progress");
    const waiting = facts.approvals.data[repo(facts).repo]?.[0];
    if (!waiting) throw new Error("Missing approval fixture");
    waiting.sha = pr.headSha;
    expect(substate(facts, "release")).toBe("waiting-on-person");
    waiting.pr = null;
    expect(substate(facts, "release")).toBe("in-progress");
    check.status = "COMPLETED";
    check.conclusion = "ACTION_REQUIRED";
    expect(substate(facts, "release")).toBe("waiting-on-person");
    waiting.pr = undefined;
    check.conclusion = "FAILURE";
    expect(substate(facts, "release")).toBe("stopped");
  });

  test("queued halts and unreleased toolchains need a person before the sync", () => {
    const facts = fixtureFacts();
    const upstream = facts.upstream.data?.partition;
    const radar = facts.radar.data?.services.partition;
    if (!upstream || !radar) throw new Error("Missing recorded upstream radar");
    const commit = upstream.commits[0] ?? facts.upstream.data?.legal?.commits[0];
    if (!commit) throw new Error("Missing recorded upstream commit");
    upstream.lag = 1;
    radar.queued = [{ ...commit, paths: ["an-unclassified-entry/file.txt"] }];
    expect(substate(facts, "upstream")).toBe("waiting-on-person");
    radar.queued = [
      {
        ...commit,
        paths: ["pom.xml"],
        hunks: { "pom.xml": ["+<os-core-common.version>9.0.0-SNAPSHOT</os-core-common.version>"] },
      },
    ];
    expect(substate(facts, "upstream")).toBe("waiting-on-person");
    radar.queued = [];
    expect(substate(facts, "upstream")).toBe("waiting-on-clock");
  });

  test("an approved, green main PR progresses only when auto-merge is allowed", () => {
    const facts = fixtureFacts();
    const pr = release(facts);
    pr.head = "release/upstream-fixture";
    pr.reviewDecision = "APPROVED";
    pr.mergeState = "CLEAN";
    repo(facts).autoMergeAllowed = true;
    expect(substate(facts, "main")).toBe("in-progress");
    repo(facts).autoMergeAllowed = false;
    expect(substate(facts, "main")).toBe("waiting-on-person");
  });
});
