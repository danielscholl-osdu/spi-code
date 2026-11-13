// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { flowActions } from "../src/act/flow.js";
import { laneActions } from "../src/act/rerun.js";
import { ROLLOUT_ITEM, rolloutActions } from "../src/act/rollout.js";
import { forkActions, planActions } from "../src/act/upstream.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { type CoreContext, createContext } from "../src/context.js";
import type { Facts } from "../src/facts.js";
import { mrBoard, mrTitle } from "../src/inspect/mr.js";
import { inspectRepo } from "../src/inspect/repo.js";
import { inspectStep } from "../src/inspect/step.js";
import { inspectUpstreamFork } from "../src/inspect/upstream-fork.js";
import { inspectUpstreamPlan } from "../src/inspect/upstream-plan.js";
import { buildModel, type Model } from "../src/model/index.js";
import { parseRollout } from "../src/rollout.js";
import { fixtureContext } from "./briefing-setup.js";
import { readyFacts, settled } from "./flow-states.js";
import { FIXTURE_NOW, fixtureFacts, laneFacts, releasedFacts } from "./harness.js";
import {
  planReadyFacts,
  stoppedFacts,
  UPSTREAM_NOW,
  UPSTREAM_SERVICES,
} from "./upstream-states.js";
import "./utc.js";

type Style = CoreContext["timeStyle"];
const UNKNOWN = [undefined, "", "not-a-time"] as const;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const junk = /Invalid Date|undefined|1970-01-01|NaN|\(\)/;

function upstream(style: Style, start: () => Facts = stoppedFacts) {
  const facts = start();
  const context = createContext({
    fleet: fleetOf(builtInFleet(UPSTREAM_SERVICES)),
    rollout: parseRollout(facts.fleet.data?.rollout as string).rollout,
    clock: { now: () => UPSTREAM_NOW },
    timeStyle: style,
  });
  return { context, model: buildModel(facts, UPSTREAM_NOW, {}, context) };
}

function storage(model: Model) {
  const fork = model.upstream.forks.find((f) => f.service === "storage");
  if (!fork?.stop?.run) throw new Error("storage stopped in its cascade");
  return fork;
}

function failedFields(model: Model, context: CoreContext) {
  const board = inspectUpstreamFork(model, "storage", UPSTREAM_NOW, { context });
  const card = board?.sections.find((s) => s.title === "What failed");
  if (card?.kind !== "cards") throw new Error("storage shows what failed");
  return card.items[0]?.fields ?? [];
}

function cascadeDetail(model: Model, context: CoreContext) {
  const opts = { swept: "s", load: model.lanes, now: UPSTREAM_NOW, context };
  const { primary } = forkActions(model.upstream, storage(model), opts);
  expect(primary.label).toBe("Re-run the cascade");
  return primary.confirm?.body ?? "";
}

function prepareDetails(model: Model, context: CoreContext) {
  const opts = { swept: "s", load: model.lanes, now: UPSTREAM_NOW, context };
  const plan = planActions(model.upstream, opts);
  const forks = model.upstream.forks.map((f) => forkActions(model.upstream, f, opts));
  return [plan, ...forks]
    .flatMap(({ primary, secondary }) => [primary, ...secondary])
    .filter((a) => a.label.startsWith("Prepare") && a.confirm)
    .map((a) => a.confirm?.body ?? "");
}

describe("an upstream fork stopped in its cascade", () => {
  it("states its failure, the next sync and the fix as instants for the app", () => {
    const { model, context } = upstream("instant");
    expect(failedFields(model, context).find((f) => f.label === "Failed")?.value).toMatch(instant);
    const board = inspectUpstreamFork(model, "storage", UPSTREAM_NOW, { context });
    const before = board?.sections.find((s) => s.title?.startsWith("Before "));
    expect(before?.title?.slice("Before ".length)).toMatch(instant);
    expect(cascadeDetail(model, context)).toMatch(/after the failed cascade \(\d{4}-[^)]+Z\), so/);
  });

  it.each(UNKNOWN)("leaves out a failure time it cannot read (%s)", (at) => {
    for (const style of ["clock", "instant"] as const) {
      const { model, context } = upstream(style);
      const run = storage(model).stop?.run;
      if (!run) throw new Error("storage has a failed run");
      run.updatedAt = at as string;
      const failed = failedFields(model, context).filter((f) => f.label === "Failed");
      expect(failed).toEqual(style === "clock" ? [{ label: "Failed", value: "?" }] : []);
      const detail = cascadeDetail(model, context);
      expect(detail).toContain("after the failed cascade, so the cascade runs again");
      expect(detail).not.toMatch(junk);
    }
  });

  it.each(UNKNOWN)("leaves out a next sync it cannot read (%s)", (at) => {
    const { model, context } = upstream("instant");
    model.upstream.schedule.upstream = at;
    const board = inspectUpstreamFork(model, "storage", UPSTREAM_NOW, { context });
    expect(board?.sections.some((s) => s.title?.startsWith("Before"))).toBe(false);
    const plan = inspectUpstreamPlan(model, UPSTREAM_NOW, { context });
    const schedule = plan.sections.find((s) => s.title === "Schedule");
    if (schedule?.kind === "rows") expect(schedule.items[0]?.chip).toBeUndefined();
    expect(JSON.stringify([board, plan])).not.toMatch(junk);
    const ready = upstream("instant", planReadyFacts);
    ready.model.upstream.schedule.upstream = at;
    const details = prepareDetails(ready.model, ready.context);
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details) {
      expect(detail).not.toContain("instead of at");
      expect(detail).not.toMatch(junk);
    }
  });

  it("names the next sync on the plan's schedule and Prepare as an instant", () => {
    const { model, context } = upstream("instant");
    const plan = inspectUpstreamPlan(model, UPSTREAM_NOW, { context });
    const schedule = plan.sections.find((s) => s.title === "Schedule");
    if (schedule?.kind !== "rows") throw new Error("the plan shows its schedule");
    expect(schedule.items[0]?.chip?.label).toMatch(instant);
    const ready = upstream("instant", planReadyFacts);
    const details = prepareDetails(ready.model, ready.context);
    expect(details.length).toBeGreaterThan(0);
    for (const detail of details)
      expect(detail).toMatch(/now instead of at \d{4}-\d{2}-\d{2}T[^ ]+Z\./);
  });
});

describe("lane re-runs", () => {
  const context = createContext({ ...fixtureContext, timeStyle: "instant" });

  function lanes(down: boolean, waiting?: { id: string; at: string }) {
    const model = buildModel(laneFacts(down), FIXTURE_NOW, {}, context);
    const item = model.queue.items.find((i) => i.id === "stack:lanes");
    if (!item) throw new Error("fixture has failed lanes");
    const opts = { swept: "s", now: FIXTURE_NOW, ops: true, context };
    return { model, item, opts: waiting ? { ...opts, waiting } : opts };
  }

  it("says how long a wait has held, or only that it holds", () => {
    const at = "2026-10-12T20:00:00Z";
    const { model, item, opts } = lanes(true, { id: "op-1", at });
    const [held] = laneActions(item, model.stack, opts);
    expect(held?.reason).toBe(`already waiting since 2026-10-12T20:00:00.000Z as op op-1`);
    for (const bad of UNKNOWN) {
      const { model, item, opts } = lanes(true, { id: "op-1", at: bad as string });
      expect(laneActions(item, model.stack, opts)[0]?.reason).toBe("already waiting as op op-1");
    }
  });

  it.each(UNKNOWN)(
    "says the stack is deployable without a green time it cannot read (%s)",
    (at) => {
      const { model, item, opts } = lanes(false);
      if (model.stack.deployable.state !== "yes" || !model.stack.lastGreen)
        throw new Error("fixture stack is deployable");
      model.stack.lastGreen = { ...model.stack.lastGreen, updatedAt: at as string };
      const body = laneActions(item, model.stack, opts)[0]?.confirm?.body ?? "";
      expect(body).toContain("The stack has been deployable. ");
      expect(body).not.toMatch(junk);
    },
  );
});

describe("the template rollout", () => {
  const context = createContext({ ...fixtureContext, timeStyle: "instant" });

  const nextSyncs: [string | undefined, string][] = [
    ["2026-10-13T00:00:00Z", " instead of at 2026-10-13T00:00:00.000Z"],
    ...UNKNOWN.map((at): [string | undefined, string] => [at, ""]),
  ];
  it.each(nextSyncs)("names its next Sync Template from %s", (at, said) => {
    const model = buildModel(settled(releasedFacts()), FIXTURE_NOW, {}, context);
    model.template.nextSync = at as string;
    const load = { cap: 1, inflight: [] };
    const [sync] = rolloutActions(
      model.template,
      { swept: "s" },
      FIXTURE_NOW,
      context.fleet.forks,
      undefined,
      load,
      context,
    );
    expect(sync?.confirm).toBeDefined();
    const text = JSON.stringify(sync);
    expect(text).not.toMatch(junk);
    if (said) expect(text).toContain(said);
    else expect(text).not.toContain("instead of at");
  });

  it("states the flow's schedule as instants, and leaves out what it cannot read", () => {
    const ctx = createContext({
      ...context,
      rollout: { lanes: 2, ordering: [{ service: "file", after: ["legal", "schema"] }] },
    });
    const start = (edit: (m: Model) => void = () => {}) => {
      const model = buildModel(readyFacts(), FIXTURE_NOW, {}, ctx);
      if (!model.rollout) throw new Error("fixture has a rollout");
      edit(model);
      const opts = {
        swept: "s",
        item: ROLLOUT_ITEM,
        load: model.lanes,
        now: FIXTURE_NOW,
        context: ctx,
      };
      return flowActions(model.rollout, opts).primary.confirm?.body ?? "";
    };
    expect(start()).toMatch(/Upstream sync at \d{4}-\d{2}-\d{2}T[^ ]+Z opens/);
    expect(
      start((m) => {
        if (m.rollout) m.rollout.schedule.template = "2026-10-12T23:00:00Z";
      }),
    ).toContain("The 2026-10-12T23:00:00.000Z template sync opens");
    for (const at of UNKNOWN) {
      const text = start((m) => {
        if (m.rollout) m.rollout.schedule.template = at;
      });
      expect(text).not.toContain("template sync opens");
      expect(text).not.toMatch(junk);
    }
    const unread = start((m) => {
      if (m.rollout) m.rollout.schedule = { ...m.rollout.schedule, upstream: "not-a-time" };
    });
    expect(unread).not.toContain("Upstream sync at");
    expect(unread).not.toMatch(junk);
  });
});

describe("boards that list a time beside each row", () => {
  const context = createContext({ ...fixtureContext, timeStyle: "instant" });

  it.each(UNKNOWN)("an MR opened at %s says nothing of when it opened", (at) => {
    const model = buildModel(fixtureFacts(), FIXTURE_NOW, {}, context);
    const id = Object.entries(model.radar.services)
      .flatMap(([name, s]) => s.possible.map((v) => `mr:${name}:${v.mr?.iid}`))
      .find((x) => mrTitle(model, x));
    if (!id) throw new Error("fixture has an MR");
    expect(mrBoard(model, id, FIXTURE_NOW, context).header.chip).toMatch(/opened \d{4}-.+Z$/);
    for (const service of Object.values(model.radar.services))
      for (const v of service.possible) if (v.mr) v.mr.createdAt = at as string;
    const chip = mrBoard(model, id, FIXTURE_NOW, context).header.chip ?? "";
    expect(chip).not.toContain("opened");
    expect(chip).not.toMatch(junk);
  });

  it.each(UNKNOWN)("a repository issue and alert read at %s leave the time out", (at) => {
    const model = buildModel(fixtureFacts(), FIXTURE_NOW, {}, context);
    const row = model.repositories.rows.find((r) => Object.values(r.issues).flat().length > 0);
    if (!row) throw new Error("fixture has an open issue");
    for (const issue of Object.values(row.issues).flat()) issue.createdAt = at as string;
    model.repositories.alertsAt = at;
    const repo = inspectRepo(model, `repo:${row.name}`, FIXTURE_NOW, context);
    const issues = repo?.tabs.find((t) => t.label === "Issues");
    const text = JSON.stringify(issues);
    expect(text).not.toContain("opened");
    expect(text).not.toMatch(junk);
    expect(repo?.chip).toContain("alerts not read yet");
  });

  it.each(UNKNOWN)("a template change made at %s keeps only its PR", (at) => {
    const model = buildModel(fixtureFacts(), FIXTURE_NOW, {}, context);
    const step = model.template.steps.find((s) => s.changes.some((c) => c.pr));
    if (!step) throw new Error("fixture has a template change with a PR");
    for (const change of step.changes) change.at = at as string;
    const inspection = inspectStep(model, `step:${step.marker}`, context);
    for (const change of inspection.changes) {
      expect(change.trailing).not.toMatch(junk);
      expect(change.trailing).not.toMatch(/·\s*$|^\s*·/);
    }
  });
});
