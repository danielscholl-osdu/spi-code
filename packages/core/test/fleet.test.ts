// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test } from "vitest";
import { createContext } from "../src/context";
import type { JobDetail } from "../src/facts";
import { failedChecks } from "../src/model/checks";
import { buildModel } from "../src/model/index";
import { nextText } from "../src/model/next";
import { withoutNoise } from "../src/model/noise";
import { governing, judgeRun, parseRollout } from "../src/rollout";
import { FORKS, fixtureContext } from "./briefing-setup";
import { FIXTURE_NOW, fixtureFacts, laneFacts, releasedFacts } from "./harness";

const ROLLOUT_TEXT = readFileSync(
  new URL("./fixtures/rib-59d6895/rollout.json", import.meta.url),
  "utf8",
);
const ROLLOUT = parseRollout(ROLLOUT_TEXT).rollout;
if (!ROLLOUT) throw new Error("the rollout fixture parses");
const TIMEOUT = "environment is not deployable after 10 minutes";
let context = fixtureContext;
afterEach(() => {
  context = fixtureContext;
});

describe("the rollout file", () => {
  test("an unknown schema leaves the buttons unpaced, with a warning", () => {
    const parsed = parseRollout(JSON.stringify({ schema: 2, lanes: 3 }));
    expect(parsed.rollout).toBeUndefined();
    expect(parsed.warnings[0]).toContain("unpaced");
    expect(parseRollout("{").warnings[0]).toContain("not JSON");
    expect(parseRollout(JSON.stringify({ schema: 1, lanes: 0 })).rollout).toEqual({});
  });
});

describe("built-in noise", () => {
  test("license/cla on an app's PR neither fails nor pends it; on a person's PR it still counts", () => {
    const facts = fixtureFacts();
    const repos = facts.github.data?.repos ?? {};
    const app = repos["Azure/osdu-spi-partition"]?.prs.find((p) => p.number === 174);
    const human = repos["Azure/osdu-spi-entitlements"]?.prs.find((p) => p.number === 49);
    if (!app || !human) throw new Error("fixture PRs");
    for (const pr of [app, human]) {
      pr.checks = pr.checks.map((c) =>
        c.name === "license/cla" ? { ...c, status: "COMPLETED", conclusion: "FAILURE" } : c,
      );
    }
    expect(failedChecks(app).map((c) => c.name)).toContain("license/cla");

    const { repos: quiet, ignored } = withoutNoise(repos);
    const appAfter = quiet["Azure/osdu-spi-partition"]?.prs.find((p) => p.number === 174);
    const humanAfter = quiet["Azure/osdu-spi-entitlements"]?.prs.find((p) => p.number === 49);
    expect(appAfter?.checks.some((c) => c.name === "license/cla")).toBe(false);
    expect(failedChecks(appAfter ?? app).map((c) => c.name)).not.toContain("license/cla");
    expect(humanAfter?.checks.some((c) => c.name === "license/cla")).toBe(true);
    expect(ignored["license-cla-app-authored"]).toBeGreaterThan(0);

    const m = buildModel(facts, FIXTURE_NOW, {}, context);
    expect(m.noise["license-cla-app-authored"]).toBe(ignored["license-cla-app-authored"]);
  });

  test("a skipped Docker Build is dropped; a failed one still counts", () => {
    const facts = fixtureFacts();
    const repos = facts.github.data?.repos ?? {};
    const pr = repos["Azure/osdu-spi-partition"]?.prs[0];
    if (!pr) throw new Error("fixture PR");
    const build = { name: "Docker Build", workflow: "Validation", status: "COMPLETED" };
    pr.checks.push(
      { ...build, id: 7e12, conclusion: "SKIPPED" },
      { ...build, id: 8e12, conclusion: "FAILURE" },
    );
    const after = withoutNoise(repos).repos["Azure/osdu-spi-partition"]?.prs[0]?.checks ?? [];
    const ids = after.map((c) => c.id);
    expect(ids).not.toContain(7e12);
    expect(ids).toContain(8e12);
  });
});

describe("failure class from the annotation title", () => {
  test("one Environment job makes the whole run environment; an unread job judges nothing", () => {
    const job = (environment?: string[]): JobDetail => ({
      id: 1,
      name: "x",
      status: "completed",
      conclusion: "failure",
      url: "",
      steps: [],
      ...(environment ? { environment } : {}),
    });
    expect(judgeRun([job([TIMEOUT]), job([])])?.class).toBe("environment");
    expect(judgeRun([job([]), job(undefined)])).toBeUndefined();
    expect(judgeRun([])).toBeUndefined();
  });

  test("the lanes item is framed by its runs: re-run once, or stop the line", () => {
    const facts = laneFacts();
    for (const d of Object.values(facts.details.data ?? {})) {
      d.environment = d.conclusion === "failure" ? [TIMEOUT] : [];
    }
    const lanes = buildModel(facts, FIXTURE_NOW, {}, context).queue.items.find(
      (i) => i.kind === "lanes",
    );
    if (!lanes) throw new Error("fixture has failed lanes");
    expect(lanes.judgement?.class).toBe("environment");
    expect(nextText(lanes)).toMatch(/re-run the failed jobs once, after the other lanes drain/i);

    for (const d of Object.values(facts.details.data ?? {})) d.attempt = 2;
    const again = buildModel(facts, FIXTURE_NOW, {}, context).queue.items.find(
      (i) => i.kind === "lanes",
    );
    expect(again?.judgement?.note).toBe("already rerun once");
    expect(again && nextText(again)).toMatch(/^Stop the line \(already rerun once\): /);
  });

  test("without read annotations the queue keeps its own words", () => {
    const m = buildModel(laneFacts(), FIXTURE_NOW, {}, context);
    expect(m.queue.items.some((i) => i.judgement)).toBe(false);
  });
});

describe("paced fleet buttons", () => {
  test("lanes in flight are read from Sync Template runs, PR Validation and main runs", () => {
    context = createContext({ ...fixtureContext, rollout: ROLLOUT });
    const facts = fixtureFacts();
    const repo = FORKS[0]?.repo ?? "";
    const runs = facts.runs.data?.[repo];
    const pr = facts.github.data?.repos[repo]?.prs[0];
    if (!runs || !pr) throw new Error("fixture runs and PRs");
    for (const r of Object.values(facts.runs.data ?? {})) {
      r.template = r.template.map((x) => ({ ...x, status: "completed" }));
      r.main = r.main.map((x) => ({ ...x, status: "completed" }));
    }
    for (const p of Object.values(facts.github.data?.repos ?? {}).flatMap((r) => r.prs)) {
      p.checks = p.checks.map((c) => ({ ...c, status: "COMPLETED" }));
    }
    pr.checks.push({
      id: 9e12,
      name: "Deploy and Test",
      workflow: "Validation",
      status: "IN_PROGRESS",
    });
    const m = buildModel(facts, FIXTURE_NOW, { pressed: { [FORKS[1]?.repo ?? ""]: "x" } }, context);
    expect(m.lanes.cap).toBe(5);
    expect(m.lanes.inflight).toEqual([
      { repo, service: FORKS[0]?.id ?? "", what: `Validation running on #${pr.number}` },
      { repo: FORKS[1]?.repo ?? "", service: FORKS[1]?.id ?? "", what: "just merged or re-run" },
    ]);
  });
});

describe("the dismiss file", () => {
  test("a dismissed item stays quiet until its inputs change", () => {
    const facts = laneFacts();
    const m = buildModel(facts, FIXTURE_NOW, {}, context);
    const item = m.queue.items.find((i) => i.kind === "lanes");
    if (!item?.fingerprint || !item.lanes?.[0]) throw new Error("fixture has failed lanes");
    const entry = { id: item.id, fingerprint: item.fingerprint };

    const quiet = buildModel(facts, FIXTURE_NOW, { dismissed: [entry] }, context);
    expect(quiet.queue.items.find((i) => i.id === item.id)).toBeUndefined();
    expect(quiet.queue.dismissed.map((d) => d.item.id)).toEqual([item.id]);
    expect(quiet.queue.counts.p1).toBe(m.queue.counts.p1 - 1);

    // The same inputs a day later stay quiet: the fingerprint ignores how stamps print.
    const tomorrow = new Date(FIXTURE_NOW.getTime() + 24 * 3600_000);
    expect(
      buildModel(facts, tomorrow, { dismissed: [entry] }, context).queue.dismissed.map(
        (d) => d.item.id,
      ),
    ).toEqual([item.id]);

    // A new head on one lane's PR is a new input, so the item comes back.
    const lane = item.lanes[0];
    const pr = facts.github.data?.repos[lane.repo]?.prs.find((p) => p.number === lane.pr);
    if (!pr) throw new Error("lane PR");
    pr.headSha = "f".repeat(40);
    const back = buildModel(facts, FIXTURE_NOW, { dismissed: [entry] }, context);
    expect(back.queue.items.find((i) => i.id === item.id)?.fingerprint).not.toBe(item.fingerprint);
    expect(back.queue.dismissed).toEqual([]);
  });
});

describe("review fixes", () => {
  test("a new head on a template-sync PR changes the rollout's fingerprint", () => {
    const facts = releasedFacts();
    const before = buildModel(facts, FIXTURE_NOW, {}, context).queue.items.find(
      (i) => i.kind === "rollout",
    );
    const pr = facts.github.data?.repos["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
    if (!before || !pr) throw new Error("fixture has a rollout");
    pr.headSha = "e".repeat(40);
    const after = buildModel(facts, FIXTURE_NOW, {}, context).queue.items.find(
      (i) => i.kind === "rollout",
    );
    expect(after?.fingerprint).not.toBe(before.fingerprint);
  });

  test("any real run stops the line for an item folding several", () => {
    const retry = { class: "environment" as const, response: "rerun-failed" as const };
    const stop = { class: "real" as const, response: "stop" as const };
    expect(governing([retry, stop])).toBe(stop);
    expect(governing([retry, undefined])).toBe(retry);
  });

  test("a new head on a release PR changes the release item's fingerprint", () => {
    const facts = fixtureFacts();
    const before = buildModel(facts, FIXTURE_NOW, {}, context).queue.items.find(
      (i) => i.id === "releases",
    );
    const pr = Object.values(facts.github.data?.repos ?? {})
      .flatMap((r) => r.prs)
      .find((p) => before?.url === p.url);
    if (!before || !pr) throw new Error("fixture has a release PR");
    pr.headSha = "d".repeat(40);
    const after = buildModel(facts, FIXTURE_NOW, {}, context).queue.items.find(
      (i) => i.id === "releases",
    );
    expect(after?.fingerprint).not.toBe(before.fingerprint);
  });

  test("a run with an Environment job and an unread failed job is not judged yet", () => {
    const job = (environment?: string[]): JobDetail => ({
      id: 1,
      name: "x",
      status: "completed",
      conclusion: "failure",
      url: "",
      steps: [],
      ...(environment ? { environment } : {}),
    });
    expect(
      judgeRun([job(["environment is not deployable after 10 minutes"]), job()]),
    ).toBeUndefined();
  });
});
