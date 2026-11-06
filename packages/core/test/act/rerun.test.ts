// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { dispatchActions, laneActions, laneTargets, WAIT_ACTION } from "../../src/act/rerun.js";
import { bindingSchema } from "../../src/act/verbs.js";
import { STACK_REPO } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import { verbsOf } from "../../src/inspect/actions.js";
import { buildModel } from "../../src/model/index.js";
import type { LaneLoad } from "../../src/model/lanes.js";
import type { QueueItem } from "../../src/model/queue.js";
import { APP_VOICE, RIB_VOICE } from "../../src/voice.js";
import { fixtureContext } from "../briefing-setup.js";
import { FIXTURE_NOW, fixtureFacts, laneFacts } from "../harness.js";

const opts = { swept: "s", now: FIXTURE_NOW, ops: true };
function model(down = false) {
  const m = buildModel(laneFacts(down), FIXTURE_NOW, {}, fixtureContext);
  const item = m.queue.items.find((i) => i.id === "stack:lanes");
  if (!item?.lanes) throw new Error("fixture has failed lanes");
  return { ...m, item };
}
function stackItem(m: ReturnType<typeof model>): QueueItem {
  const item = m.queue.items.find((i) => i.kind === "stack");
  if (!item) throw new Error("fixture has failed lifecycle attempt");
  return item;
}

describe("the environment verbs", () => {
  test("two contexts assemble lifecycle dispatches for their own stack repository", () => {
    const contexts = ["one/stack", "two/environment"].map((stackRepo) =>
      createContext({ ...fixtureContext, stackRepo }),
    );
    const facts = laneFacts(true);
    const repos = facts.github.data?.repos;
    const original = repos?.[STACK_REPO];
    if (!repos || !original) throw new Error("fixture has a stack");
    for (const context of contexts) {
      repos[context.stackRepo] = { ...original, repo: context.stackRepo };
    }
    delete repos[STACK_REPO];
    for (const context of [...contexts, ...[...contexts].reverse()]) {
      const m = buildModel(facts, FIXTURE_NOW, {}, context);
      const item = m.queue.items.find((i) => i.kind === "stack");
      if (!item) throw new Error("fixture has a failed lifecycle attempt");
      for (const kind of ["stack", "maintenance"] as const) {
        const actions = verbsOf({ ...item, kind }, m, context, { scopes: ["repo"] });
        expect(actions).toHaveLength(2);
        for (const action of actions) {
          expect(bindingSchema.parse(action.binding).targets).toEqual([
            {
              repo: context.stackRepo,
              kind: "workflow",
              state: "idle",
              label: action.label.replace("Re-dispatch ", ""),
            },
          ]);
          expect(action.confirm?.body).toContain(`-R ${context.stackRepo}`);
          expect(action.confirm?.title).toBe(`${action.label} · ${context.stackRepo}`);
          expect(action.confirm?.body).not.toContain(STACK_REPO);
        }
      }
    }
  });

  test("while deployable, one Re-run lanes confirmation names each PR and run and every command", () => {
    const m = model();
    const [rerun, ...rest] = laneActions(m.item, m.stack, opts);
    expect(rest).toEqual([]);
    expect(rerun).toMatchObject({ type: "act", label: "Re-run lanes · 5", tone: "brand" });
    expect(rerun?.confirm?.title).toBe("Re-run 5 failed lanes");
    const body = rerun?.confirm?.body ?? "";
    expect(body).toContain("The stack has been deployable since ");
    expect(body).toContain("Each lane failed in Confirm environment deployable");
    expect(body).toContain("schema #37 run 38224682332");
    for (const [repo, id] of [
      ["partition", 38222934119],
      ["entitlements", 38224153176],
      ["legal", 38224167314],
      ["schema", 38224682332],
      ["file", 38223915937],
    ]) {
      expect(body).toContain(`gh run rerun ${id} --failed -R Azure/osdu-spi-${repo}`);
    }
    expect(body).toContain("one that changed since the board drew it is skipped and named");
    expect(bindingSchema.parse(rerun?.binding).targets).toEqual(laneTargets(m.item.lanes ?? []));
  });

  test("while not deployable, Re-run when deployable replaces it, and needs durable ops", () => {
    const m = model(true);
    const [noOps] = laneActions(m.item, m.stack, { ...opts, ops: false });
    expect(noOps).toMatchObject({
      type: WAIT_ACTION,
      label: "Re-run when deployable",
      disabled: true,
      reason: "SPI Code has no durable ops here",
    });
    expect(noOps?.confirm).toBeUndefined();
    const [wait] = laneActions(m.item, m.stack, opts);
    expect(wait?.disabled).toBeUndefined();
    expect(wait?.confirm?.title).toBe("Re-run 5 failed lanes when deployable");
    expect(wait?.confirm?.body).toContain(`not deployable now (${m.stack.deployable.reason})`);
    expect(wait?.confirm?.body).toContain(
      "An SPI Code restart drops the wait and the item stays in the queue.",
    );
    expect(wait?.confirm?.body).not.toContain("Keelson");
    expect(wait?.confirm?.body).toContain(
      "gh run rerun 38224682332 --failed -R Azure/osdu-spi-schema",
    );
  });

  test("an existing wait defaults to app wording without a cancel tool", () => {
    const m = model(true);
    const [held] = laneActions(m.item, m.stack, {
      ...opts,
      waiting: { id: "op-7", at: "2026-10-12T21:45:00Z" },
    });
    expect(held).toMatchObject({
      type: WAIT_ACTION,
      disabled: true,
      reason: "already waiting since 21:45 as op op-7",
    });
    expect(held?.confirm).toBeUndefined();
  });

  test.each([
    {
      name: "app",
      voice: APP_VOICE,
      reason: "SPI Code has no durable ops here",
      restart: "An SPI Code restart",
      waitingReason: "already waiting since 21:45 as op op-7",
      other: "Keelson",
    },
    {
      name: "rib",
      voice: RIB_VOICE,
      reason: "this Keelson has no durable ops",
      restart: "A Keelson restart",
      waitingReason: "already waiting since 21:45 as op op-7; run_cancel drops it",
      other: "SPI Code",
    },
  ])(
    "$name inspector uses its context voice for durable-op offers",
    ({ voice, reason, restart, waitingReason, other }) => {
      const m = model(true);
      const context = createContext({
        ...fixtureContext,
        clock: { now: () => FIXTURE_NOW },
        voice,
      });
      const [noOps] = verbsOf(m.item, m, context, { scopes: ["repo"] });
      expect(noOps).toMatchObject({ type: WAIT_ACTION, disabled: true, reason });
      expect(noOps?.confirm).toBeUndefined();
      const [wait] = verbsOf(m.item, m, context, { scopes: ["repo"], ops: true });
      expect(wait?.confirm?.body).toContain(
        `It stands down without writing if a lifecycle run fails again. ${restart} drops the wait and the item stays in the queue.`,
      );
      expect(wait?.confirm?.body).not.toContain(other);
      const [held] = verbsOf(m.item, m, context, {
        scopes: ["repo"],
        ops: true,
        waiting: { id: "op-7", at: "2026-10-12T21:45:00Z" },
      });
      expect(held).toMatchObject({
        type: WAIT_ACTION,
        disabled: true,
        reason: waitingReason,
      });
      expect(held?.confirm).toBeUndefined();
    },
  );

  test("a failed lifecycle attempt offers both re-dispatches, the one that stopped first", () => {
    const m = model(true);
    const [refresh, upgrade] = dispatchActions(stackItem(m), m.stack, opts);
    expect(refresh).toMatchObject({ label: "Re-dispatch env-refresh", tone: "brand" });
    expect(refresh?.confirm?.body).toContain(
      "gh workflow run env-refresh.yml -R Azure/osdu-spi-stack",
    );
    expect(refresh?.confirm?.body).toContain("It clears maintenance only after its probes pass");
    expect(upgrade?.label).toBe("Re-dispatch env-upgrade");
    expect(upgrade?.tone).toBeUndefined();
    expect(upgrade?.confirm?.body).toContain(
      "gh workflow run env-upgrade.yml -R Azure/osdu-spi-stack",
    );
    expect(upgrade?.confirm?.body).toContain("It takes no inputs");
    expect(bindingSchema.parse(upgrade?.binding)).toMatchObject({
      verb: "dispatch-env-upgrade",
      item: stackItem(m).id,
      swept: "s",
      targets: [{ repo: "Azure/osdu-spi-stack", kind: "workflow", state: "idle" }],
    });
  });

  test("re-dispatch is disabled while a lifecycle run is in flight, and without the repo scope", () => {
    const m = buildModel(fixtureFacts(), FIXTURE_NOW, {}, fixtureContext);
    const item = m.queue.items.find((i) => i.kind === "stack");
    if (!item) throw new Error("fixture has a stack incident");
    const busy = dispatchActions(item, m.stack, opts);
    expect(busy.map((a) => a.label)).toEqual([
      "Re-dispatch env-upgrade",
      "Re-dispatch env-refresh",
    ]);
    for (const a of busy) {
      expect(a.disabled).toBe(true);
      expect(a.reason).toBe("env-upgrade v0.28.2 is running in concurrency group env-shared");
      expect(a.confirm).toBeUndefined();
    }
    for (const a of dispatchActions(item, m.stack, { ...opts, blocked: "missing repo scope" })) {
      expect(a.reason).toBe("missing repo scope");
    }
    if (!m.stack.inflight) throw new Error("fixture has inflight lifecycle run");
    const queued = {
      ...m.stack,
      inflight: {
        ...m.stack.inflight,
        run: { ...m.stack.inflight.run, status: "queued" },
      },
    };
    expect(dispatchActions(item, queued, opts)[0]?.reason).toContain("is queued");
  });

  test("a maintenance hold re-dispatches env-refresh first", () => {
    const m = model(true);
    const [first] = dispatchActions({ ...m.item, kind: "maintenance" }, m.stack, opts);
    expect(first?.label).toBe("Re-dispatch env-refresh");
    expect(first?.tone).toBe("brand");
    expect(dispatchActions(m.item, m.stack, opts)).toEqual([]);
    expect(laneActions({ ...m.item, lanes: [] }, m.stack, opts)).toEqual([]);
  });
});

describe("lane pacing and judgement", () => {
  test("Re-run lanes takes the same cap", () => {
    const m = model();
    const [button] = laneActions(m.item, m.stack, {
      ...opts,
      load: { cap: 1, inflight: [] },
    });
    const targets = bindingSchema.parse(button?.binding).targets;
    expect(new Set(targets.map((t) => t.repo)).size).toBe(1);
    expect(button?.label).toBe("Re-run lanes · 1 · 4 wait");
    for (const [load, reason] of [
      [
        { cap: 1, inflight: [{ repo: "other/fork", service: "other", what: "busy" }] },
        "1 of 1 lanes in flight; 5 lanes wait for the next press",
      ],
      [{ cap: 1, inflight: [], unread: "PR checks" }, "lanes unknown until PR checks are read"],
    ] satisfies [LaneLoad, string][]) {
      const [full] = laneActions(m.item, m.stack, { ...opts, load });
      expect(full?.reason).toBe(reason);
      expect(full?.confirm).toBeUndefined();
    }
    const [wait] = laneActions(m.item, model(true).stack, {
      ...opts,
      load: { cap: 1, inflight: [] },
    });
    expect(wait?.confirm?.body).toContain("as the 1-lane cap leaves room for");
  });

  test("a stop judgement draws no re-run, now or when deployable", () => {
    const m = model();
    const item = {
      ...m.item,
      judgement: {
        class: "real" as const,
        response: "stop" as const,
        note: "already rerun once",
      },
    };
    for (const stack of [m.stack, model(true).stack]) {
      const [button] = laneActions(item, stack, opts);
      expect(button).toMatchObject({
        disabled: true,
        reason: "stop the line (already rerun once): fix it forward in the template, no re-run",
      });
      expect(button?.confirm).toBeUndefined();
      expect(laneActions(item, stack, { ...opts, blocked: "missing repo scope" })[0]?.reason).toBe(
        "missing repo scope",
      );
    }
    expect(
      laneActions(
        {
          ...m.item,
          judgement: {
            class: "environment",
            response: "rerun-failed",
          },
        },
        m.stack,
        opts,
      )[0]?.disabled,
    ).toBeUndefined();
  });

  test("distinct runs for the same PR keep their bindings and name differing failed steps", () => {
    const m = model();
    const lane = m.item.lanes?.[0];
    if (!lane) throw new Error("fixture has a lane");
    const lanes = [lane, { ...lane, runId: 123, step: "Probe gateway" }];
    expect(laneTargets(lanes).map((t) => t.label)).toEqual([
      `${lane.service} #${lane.pr} run ${lane.runId}`,
      `${lane.service} #${lane.pr} run 123`,
    ]);
    const [button] = laneActions({ ...m.item, lanes }, m.stack, {
      ...opts,
      load: { cap: 1, inflight: [] },
    });
    expect(bindingSchema.parse(button?.binding).targets).toHaveLength(2);
    expect(button?.confirm?.body).toContain(`run ${lane.runId} (${lane.step})`);
    expect(button?.confirm?.body).toContain("run 123 (Probe gateway)");
    expect(
      laneActions({ ...m.item, lanes: [lane] }, model(true).stack, opts)[0]?.confirm?.body,
    ).toContain("A wait holds this lane");
  });
});
