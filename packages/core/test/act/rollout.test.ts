// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  heldBecause,
  heldText,
  paced,
  paceText,
  ROLL_OUT,
  ROLLOUT_ITEM,
  rolloutActions,
  rolloutTargets,
  SYNC_FORKS,
  syncTargets,
  waitSuffix,
} from "../../src/act/rollout.js";
import { bindingSchema, commandText } from "../../src/act/verbs.js";
import type { Facts } from "../../src/facts.js";
import { buildModel } from "../../src/model/index.js";
import type { LaneLoad } from "../../src/model/lanes.js";
import { fixtureContext } from "../briefing-setup.js";
import { settled } from "../flow-states.js";
import { FIXTURE_NOW, NEW_HEAD, releasedFacts } from "../harness.js";

const SWEPT = { swept: "2026-10-12T21:58:14.428Z" };

function model(edit?: (f: Facts) => void) {
  const f = settled(releasedFacts());
  edit?.(f);
  return buildModel(f, FIXTURE_NOW, {}, fixtureContext);
}

function ready(f: Facts, repo: string, number: number) {
  const pr = f.github.data?.repos[repo]?.prs.find((p) => p.number === number);
  if (!pr) throw new Error(`${repo}#${number}`);
  pr.reviewDecision = "APPROVED";
  pr.mergeState = "CLEAN";
  pr.checks = pr.checks.map((c) => ({ ...c, status: "COMPLETED", conclusion: "SUCCESS" }));
}

function readyModel() {
  return model((f) => {
    ready(f, "Azure/osdu-spi-legal", 33);
    ready(f, "Azure/osdu-spi-schema", 37);
  });
}

describe("Sync all forks", () => {
  test("dispatches every fork behind main whose PR does not carry it", () => {
    const { targets, skipped } = syncTargets(model().template);
    expect(targets.map((t) => t.label).sort()).toEqual([
      "entitlements",
      "file",
      "legal",
      "partition",
      "schema",
    ]);
    expect(skipped).toEqual([]);
    const first = targets[0];
    if (!first) throw new Error("fixture has a dispatch target");
    expect(commandText(SYNC_FORKS, first)).toMatch(
      /^gh workflow run sync-template\.yml -R Azure\/osdu-spi-\w+$/,
    );
  });

  test("skips a fork already syncing and one whose PR is at main", () => {
    const m = model((f) => {
      const legal = f.github.data?.repos["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
      if (legal) legal.headMarker = NEW_HEAD;
      const runs = f.runs.data?.["Azure/osdu-spi-file"];
      const last = runs?.template[0];
      if (runs && last)
        runs.template = [{ ...last, id: 1, status: "in_progress" }, ...runs.template];
    });
    const { targets, skipped } = syncTargets(m.template);
    expect(targets.map((t) => t.label).sort()).toEqual(["entitlements", "partition", "schema"]);
    expect(skipped).toEqual(["file (Sync Template running)"]);
  });
});

describe("Roll out", () => {
  test("nothing is ready while every PR needs review and is red on the stack", () => {
    const m = model();
    const { targets, held } = rolloutTargets(m.template);
    expect(targets).toEqual([]);
    expect(held.map((h) => h.why)).toEqual(Array(5).fill("is red on the stack"));
    const [, roll] = rolloutActions(m.template, SWEPT, FIXTURE_NOW);
    expect(roll).toMatchObject({ label: "Roll out · 0 ready", disabled: true });
    expect(roll?.reason).toMatch(/^nothing is ready: /);
    expect(roll?.confirm).toBeUndefined();
  });

  test("merges the approved green PRs and names each one held back and why", () => {
    const m = model((f) => {
      ready(f, "Azure/osdu-spi-legal", 33);
      ready(f, "Azure/osdu-spi-schema", 37);
      ready(f, "Azure/osdu-spi-entitlements", 48);
      const ent = f.github.data?.repos["Azure/osdu-spi-entitlements"]?.prs.find(
        (p) => p.number === 48,
      );
      if (ent) ent.reviewDecision = "REVIEW_REQUIRED";
      ready(f, "Azure/osdu-spi-partition", 174);
      const part = f.github.data?.repos["Azure/osdu-spi-partition"]?.prs.find(
        (p) => p.number === 174,
      );
      if (part) part.mergeState = "DIRTY";
    });
    const { targets, held } = rolloutTargets(m.template);
    expect(targets.map((t) => t.label)).toEqual(["legal #33", "schema #37"]);
    expect(targets[0]).toMatchObject({ kind: "pr", state: "open", number: 33 });
    const first = targets[0];
    if (!first) throw new Error("fixture has a merge target");
    expect(commandText(ROLL_OUT, first)).toBe("gh pr merge 33 -R Azure/osdu-spi-legal --merge");
    expect(Object.fromEntries(held.map((h) => [h.row.service, h.why]))).toEqual({
      partition: "has conflicts",
      entitlements: "needs review",
      file: "is red on the stack",
    });
    const [, roll] = rolloutActions(m.template, SWEPT, FIXTURE_NOW);
    expect(roll?.label).toBe("Roll out · 2 ready");
    expect(roll?.pendingLabel).toBe("Merging 2…");
    expect(roll?.confirm?.irreversible).toBe(true);
    expect(roll?.confirm?.subject).toBe("2");
    expect(roll?.confirm?.body).toContain(
      "Merges legal #33 and schema #37 into main with a merge commit, taking each fork to v1.2.0 +14.",
    );
    expect(roll?.confirm?.body).toContain("Held back: partition #174 has conflicts;");
    expect(roll?.confirm?.body).toContain("entitlements #48 needs review");
    expect(bindingSchema.parse(roll?.binding)).toMatchObject({
      verb: ROLL_OUT.id,
      item: ROLLOUT_ITEM,
      ...SWEPT,
      targets,
    });
  });

  test("a draft and running checks hold a PR too", () => {
    const m = model((f) => {
      ready(f, "Azure/osdu-spi-legal", 33);
      const legal = f.github.data?.repos["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
      if (legal) legal.draft = true;
    });
    const legal = m.template.rows.find((r) => r.service === "legal");
    expect(legal && heldBecause(legal)).toBe("is a draft");
    if (!legal?.pr) throw new Error("fixture has legal PR");
    expect(heldBecause({ ...legal, pr: { ...legal.pr, draft: false }, verdict: "pending" })).toBe(
      "has checks running",
    );
  });
});

describe("lane pacing and eligibility", () => {
  test("paces by distinct repo in board order, reserves claims, and leaves uncapped presses alone", () => {
    const eligible = rolloutTargets(readyModel().template).targets;
    const first = eligible[0];
    if (!first) throw new Error("fixture has a merge target");
    const targets = [first, { ...first, label: "another PR" }, ...eligible.slice(1)];
    expect(
      paced(targets, {
        cap: 2,
        inflight: [],
        claims: [{ repo: "x/y", service: "y", what: "cascade" }],
      }),
    ).toEqual({ targets: targets.slice(0, 2), waiting: targets.slice(2) });
    expect(paced(targets, undefined)).toEqual({ targets, waiting: [] });
    expect(paced(targets, { cap: null, inflight: [], unread: "PR checks" })).toEqual({
      targets,
      waiting: [],
    });
  });

  test("a full or unread lane load disables both actions without a confirmation", () => {
    const template = readyModel().template;
    const busy = { repo: "other/fork", service: "other", what: "main Validation running" };
    for (const [load, why] of [
      [{ cap: 1, inflight: [busy] }, "1 of 1 lanes in flight;"],
      [{ cap: 2, inflight: [], unread: "PR checks" }, "lanes unknown until PR checks are read"],
    ] satisfies [LaneLoad, string][]) {
      for (const action of rolloutActions(template, SWEPT, FIXTURE_NOW, undefined, load)) {
        expect(action.disabled).toBe(true);
        expect(action.reason).toContain(why);
        expect(action.confirm).toBeUndefined();
        expect(bindingSchema.parse(action.binding).targets).toEqual([
          { repo: "Azure/osdu-spi", kind: "repo", label: "none" },
        ]);
      }
    }
  });

  test("skips dispatched and busy forks, preserves held reasons and explains the waiting forks", () => {
    const template = readyModel().template;
    const partition = template.rows.find((r) => r.service === "partition");
    if (!partition) throw new Error("fixture has partition");
    partition.dispatched = SWEPT.swept;
    const load: LaneLoad = {
      cap: 2,
      inflight: [
        { repo: "Azure/osdu-spi-legal", service: "legal", what: "main Validation running" },
      ],
    };
    expect(syncTargets(template, load).skipped).toEqual([
      "partition (Sync Template dispatched)",
      "legal (main Validation running)",
    ]);
    const roll = rolloutTargets(template, load);
    expect(roll.targets.map((t) => t.label)).toEqual(["schema #37"]);
    expect(heldText(roll.held)).toContain(
      "legal #33 has a lane in flight (main Validation running)",
    );
    const sync = syncTargets(template, load);
    expect(paceText(load, sync.waiting)).toEqual([
      "Paced to 2 lanes on the shared environment: 1 in flight now (legal), and a press only tops up to 2.",
      "2 more forks wait for the next press: schema and file.",
    ]);
    expect(waitSuffix(sync.waiting)).toBe(" · 2 wait");
    expect(heldText([])).toBeUndefined();
    expect(paceText(undefined, [])).toEqual([]);
    expect(waitSuffix([])).toBe("");
  });

  test("blocked reasons override eligibility and no-PR or current fleets cannot confirm", () => {
    const template = readyModel().template;
    for (const action of rolloutActions(template, SWEPT, FIXTURE_NOW, "missing repo scope")) {
      expect(action).toMatchObject({ disabled: true, reason: "missing repo scope" });
      expect(action.confirm).toBeUndefined();
    }
    const rows = template.rows.map((r) => ({ ...r, behind: 0, pr: undefined }));
    const [sync, roll] = rolloutActions({ ...template, rows }, SWEPT, FIXTURE_NOW);
    expect(sync?.reason).toBe("every fork is on v1.3.0 or its PR carries it");
    expect(roll?.reason).toBe("no template-sync PR is open");
    expect(sync?.confirm).toBeUndefined();
    expect(roll?.confirm).toBeUndefined();
    expect(syncTargets({ ...template, head: undefined }).targets).toEqual([]);
  });

  test("enabled sync confirmations carry exact commands and capped merge confirmations count only targets", () => {
    const template = readyModel().template;
    const [sync, roll] = rolloutActions(template, SWEPT, FIXTURE_NOW, undefined, {
      cap: 1,
      inflight: [],
    });
    expect(sync?.disabled).toBeUndefined();
    expect(sync?.label).toBe("Sync all forks · 1 · 4 wait");
    expect(sync?.confirm?.body).toContain(
      "Calls: gh workflow run sync-template.yml -R Azure/osdu-spi-partition.",
    );
    expect(sync?.confirm?.body).toContain("instead of at");
    expect(bindingSchema.parse(sync?.binding)).toMatchObject({
      verb: SYNC_FORKS.id,
      item: ROLLOUT_ITEM,
      ...SWEPT,
    });
    expect(roll?.label).toBe("Roll out · 1 ready · 1 wait");
    expect(roll?.confirm).toMatchObject({
      irreversible: true,
      subject: "1",
      label: "Type 1: the number of PRs this merges into main",
    });
    expect(roll?.confirm?.body).toContain("Calls: gh pr merge 33 -R Azure/osdu-spi-legal --merge.");
  });
});
