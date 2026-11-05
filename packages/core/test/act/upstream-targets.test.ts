// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  cascadeAction,
  cascadeTarget,
  DISPATCH_CASCADE,
  PREPARE,
  prepareAction,
  prepareTarget,
  RERUN_CASCADE,
  START,
  startAction,
  startTarget,
} from "../../src/act/upstream-targets.js";
import { type ActionItem, bindingSchema, commandText } from "../../src/act/verbs.js";
import { builtInFleet, fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { Facts } from "../../src/facts.js";
import { buildModel } from "../../src/model/index.js";
import type { UpstreamModel } from "../../src/model/upstream.js";
import { parseRollout } from "../../src/rollout.js";
import { stamp } from "../../src/util.js";
import {
  envHeld,
  planReadyFacts,
  stoppedFacts,
  UPSTREAM_NOW,
  UPSTREAM_SERVICES,
  waveFacts,
} from "../upstream-states.js";

function modelOf(f: Facts) {
  return buildModel(
    f,
    UPSTREAM_NOW,
    {},
    createContext({
      fleet: fleetOf(builtInFleet(UPSTREAM_SERVICES)),
      rollout: parseRollout(f.fleet.data?.rollout as string).rollout,
    }),
  );
}

function binding(a: ActionItem) {
  expect(a.disabled).toBeUndefined();
  expect(a.reason).toBeUndefined();
  expect(a.confirm).toBeDefined();
  return bindingSchema.parse(a.binding);
}

const opts = { swept: UPSTREAM_NOW.toISOString(), item: "upstream", now: UPSTREAM_NOW };
const recheck =
  "Each target is read again first; one that changed since the board drew it is skipped and named in the result.";

describe("upstream target buttons", () => {
  test("the primary press prepares the pilot and nothing merges", () => {
    const u = modelOf(planReadyFacts()).upstream;
    const a = prepareAction(
      { ...u, schedule: { ...u.schedule, upstream: undefined } },
      u.prepareNext,
      { ...opts, primary: true, extra: ["Pilot first."] },
    );
    const b = binding(a);
    expect(b.targets.map((t) => t.label)).toEqual(["partition", "indexer-queue"]);
    expect(b.verb).toBe(PREPARE.id);
    expect(a.tone).toBe("brand");
    expect(a.pendingLabel).toBe("Dispatching Sync Upstream on 2…");
    expect(a.confirm).toEqual({
      title: "Prepare · dispatch Sync Upstream on 2 forks",
      confirmLabel: "Prepare partition and indexer-queue",
      body: [
        "Dispatches Sync Upstream on partition and indexer-queue. Each opens a sync PR into fork_upstream with the filtered tree and a tracking issue. Nothing merges, and no lane is taken. Pilot first. Each fork is read again first: one with a sync PR already open or Sync Upstream running is skipped.",
        "Calls: gh workflow run sync.yml -R Azure/osdu-spi-partition; gh workflow run sync.yml -R Azure/osdu-spi-indexer-queue.",
        recheck,
      ].join("\n\n"),
    });
    const first = b.targets[0];
    if (!first) throw new Error("fixture has a pilot target");
    expect(commandText(PREPARE, first)).toBe(
      "gh workflow run sync.yml -R Azure/osdu-spi-partition",
    );
  });

  test("Start merges the sync PR, then dispatches the cascade with its tracking issue", () => {
    const m = modelOf(waveFacts());
    const u = {
      ...m.upstream,
      lanes: { cap: 5, busy: 1, claims: 2, room: 2, holders: ["schema"] },
      ordering: [
        { service: "file", after: ["storage"], reason: "dependency" },
        { service: "workflow", after: ["storage", "indexer"] },
        { service: "search", after: ["file"] },
      ],
    };
    const a = startAction(u, u.startNext, {
      ...opts,
      load: m.lanes,
      primary: true,
      extra: ["Wave first."],
    });
    const b = binding(a);
    expect(b.verb).toBe(START.id);
    expect(b.targets.map((t) => t.label.split(" ")[0])).toEqual(["file", "workflow"]);
    const [file, workflow] = b.targets;
    if (!file || !workflow) throw new Error("fixture has two Start targets");
    const command = `gh pr merge ${file.number} -R Azure/osdu-spi-file --merge && gh workflow run cascade.yml -R Azure/osdu-spi-file -f issue_number=${file.issue}`;
    expect(commandText(START, file)).toBe(command);
    expect(a.confirm).toEqual({
      title: "Start · merge 2 sync PRs and dispatch the cascade",
      confirmLabel: "Start file and workflow",
      irreversible: true,
      subject: "2",
      label: "Type 2: the number of sync PRs this merges",
      body: [
        `Merges file #${file.number} and workflow #${workflow.number} into fork_upstream with a merge commit, then dispatches Cascade Integration with each tracking issue at once instead of waiting up to 6 hours for the monitor. The cascade merges main and upstream into fork_integration and builds core and azure on GitHub runners. A green one opens a Sync to Main PR that borrows a lane, and its push to main borrows another. Lanes are shared with the template rollout: 1 of 5 in flight (schema), 2 cascades claiming one. A press only tops up to 5. file starts only after storage is on main (dependency). workflow starts only after storage and indexer are on main. Wave first.`,
        `Calls: ${command}; gh pr merge ${workflow.number} -R Azure/osdu-spi-workflow --merge && gh workflow run cascade.yml -R Azure/osdu-spi-workflow -f issue_number=${workflow.issue}.`,
        recheck,
      ].join("\n\n"),
    });
  });

  test.each([DISPATCH_CASCADE, RERUN_CASCADE])(
    "$label confirms the exact cascade command",
    (verb) => {
      const u = modelOf(stoppedFacts()).upstream;
      const s = u.forks.find((f) => f.service === "storage");
      if (!s?.stop?.run) throw new Error("fixture has a stopped storage cascade");
      const a = cascadeAction(verb, { ...u, lanes: { ...u.lanes, cap: null } }, [s], opts);
      const b = binding(a);
      expect(b.verb).toBe(verb.id);
      expect(b.targets[0]?.issue).toBe(s.tracking?.number);
      expect(b.targets[0]?.number).toBe(s.cascadeRun?.id);
      expect(a.pendingLabel).toBe(verb === RERUN_CASCADE ? "Re-running…" : "Dispatching…");
      expect(a.confirm).toEqual({
        title: `${verb.label} · storage`,
        confirmLabel: `${verb.label} · storage`,
        body: [
          `${
            verb === RERUN_CASCADE
              ? `A fix landed on fork_integration after the failed cascade (${stamp(s.stop.run.updatedAt, opts.now)}), so the cascade runs again with each tracking issue.`
              : "The sync PR merged and no cascade ran, so this dispatches Cascade Integration with each tracking issue."
          } A green cascade opens a Sync to Main PR that borrows a lane. Unpaced: rollout.json sets no lane cap. Each fork is read again first: one with a cascade already running is skipped.`,
          `Calls: gh workflow run cascade.yml -R Azure/osdu-spi-storage -f issue_number=${s.tracking?.number}.`,
          recheck,
        ].join("\n\n"),
      });
    },
  );

  test("Prepare is not gated on the environment", () => {
    const u = modelOf(envHeld(planReadyFacts())).upstream;
    expect(u.envHeld).toBeDefined();
    const f = u.prepareNext[0];
    if (!f) throw new Error("fixture has a pilot");
    const schedule = new Date(2026, 10, 5, 8, 30);
    const a = prepareAction(
      { ...u, schedule: { ...u.schedule, upstream: schedule.toISOString() } },
      [f],
      { ...opts, now: schedule, label: "Prepare now" },
    );
    expect(binding(a).verb).toBe(PREPARE.id);
    expect(a.label).toBe("Prepare now");
    expect(a.tone).toBeUndefined();
    expect(a.confirm?.title).toBe("Prepare · dispatch Sync Upstream on 1 fork");
    expect(a.confirm?.body).toContain("now instead of at 08:30");
  });

  test.each([
    [
      { cap: null, busy: 0, claims: 0, room: 0, holders: [] },
      "Unpaced: rollout.json sets no lane cap.",
    ],
    [
      { cap: 5, busy: 0, claims: 0, room: 0, holders: [], unread: "fork workflow runs" },
      "Lanes unknown until fork workflow runs are read, so nothing starts.",
    ],
    [
      { cap: 5, busy: 0, claims: 0, room: 5, holders: [] },
      "Lanes are shared with the template rollout: 0 of 5 in flight. A press only tops up to 5.",
    ],
  ] satisfies [UpstreamModel["lanes"], string][])(
    "keeps lane confirmation wording for %j",
    (lanes, text) => {
      const m = modelOf(waveFacts());
      const forks = m.upstream.startNext.slice(0, 1);
      const a = startAction({ ...m.upstream, lanes }, forks, {
        ...opts,
        load: m.lanes,
        label: "Start now",
      });
      binding(a);
      expect(a.confirm?.body).toContain(text);
      expect(a.confirm?.subject).toBe("1");
      expect(a.confirm?.title).toBe("Start · merge 1 sync PR and dispatch the cascade");
      expect(a.confirm?.confirmLabel).toBe("Start now");
    },
  );

  test("cascade targets bind the newest run and omit absent optional evidence", () => {
    const u = modelOf(stoppedFacts()).upstream;
    const s = u.forks.find((f) => f.service === "storage");
    if (!s) throw new Error("fixture has storage");
    const without = { ...s, cascadeRun: undefined, tracking: undefined, stop: undefined };
    expect(cascadeTarget(without)).toEqual({
      repo: s.repo,
      kind: "workflow",
      workflow: "cascade.yml",
      state: "idle",
      label: "storage",
    });
    expect(startTarget(s)).toMatchObject({
      repo: s.repo,
      kind: "pr",
      state: "open",
      issue: s.tracking?.number,
    });
    expect(prepareTarget(s)).toEqual({
      repo: s.repo,
      kind: "workflow",
      workflow: "sync.yml",
      state: "idle",
      label: "storage",
    });
    const a = cascadeAction(RERUN_CASCADE, u, [without, without], {
      ...opts,
      label: "Retry both",
      primary: true,
    });
    expect(binding(a).targets).toHaveLength(2);
    expect(a.tone).toBe("brand");
    expect(a.confirm?.confirmLabel).toBe("Retry both");
    expect(a.confirm?.body).toContain("after the failed cascade, so");
    expect(commandText(DISPATCH_CASCADE, cascadeTarget(without))).toBe(
      "gh workflow run cascade.yml -R Azure/osdu-spi-storage -f issue_number=",
    );
  });
});
