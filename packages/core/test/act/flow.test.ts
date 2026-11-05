// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { FLEET_RELEASE, flowActions } from "../../src/act/flow.js";
import { RERUN_LANES } from "../../src/act/rerun.js";
import { ROLL_OUT, ROLLOUT_ITEM, SYNC_FORKS } from "../../src/act/rollout.js";
import { bindingSchema, commandText } from "../../src/act/verbs.js";
import { createContext } from "../../src/context.js";
import type { Facts } from "../../src/facts.js";
import { buildModel } from "../../src/model/index.js";
import { fixtureContext } from "../briefing-setup.js";
import {
  doneFacts,
  headSha,
  heldFacts,
  job,
  merged,
  ready,
  readyFacts,
  settled,
} from "../flow-states.js";
import { FIXTURE_NOW, fixtureFacts, NEW_HEAD } from "../harness.js";

function model(f: Facts, lanes = 2) {
  return buildModel(
    f,
    FIXTURE_NOW,
    {},
    createContext({
      ...fixtureContext,
      rollout: { lanes, ordering: [{ service: "file", after: ["legal", "schema"] }] },
    }),
  );
}

function actions(m: ReturnType<typeof model>, blocked?: string) {
  if (!m.rollout) throw new Error("fixture must have a rollout");
  return flowActions(m.rollout, {
    swept: "2026-10-12T21:58:14.428Z",
    item: ROLLOUT_ITEM,
    load: m.lanes,
    now: FIXTURE_NOW,
    blocked,
  });
}

describe("flow action planning", () => {
  test("Start rollout dispatches the first wave, carrying main's sha, and the rest wait", () => {
    const { primary: start, secondary: rest } = actions(model(readyFacts()));
    expect(start.label).toBe("Start rollout · dispatch Sync Template to 2 forks");
    const binding = bindingSchema.parse(start.binding);
    expect(binding).toMatchObject({ verb: SYNC_FORKS.id, item: ROLLOUT_ITEM });
    expect(binding.targets.map((t) => [t.label, t.sha])).toEqual([
      ["partition", NEW_HEAD],
      ["entitlements", NEW_HEAD],
    ]);
    expect(start.tone).toBe("brand");
    expect(rest.find((a) => a.label.startsWith("Dispatch"))).toMatchObject({
      label: "Dispatch legal, schema and file · on the next press",
      disabled: true,
    });
    expect(start.confirm?.body).toContain("file merges only after legal and schema");
    expect(start.confirm?.body).toContain("Upstream sync at");
    expect(start.confirm?.irreversible).toBeUndefined();
    expect(start.confirm?.subject).toBeUndefined();
  });

  test("merges the approved PRs into the free lanes and holds an ordered fork", () => {
    const f = settled(fixtureFacts());
    merged(f, "partition");
    for (const svc of ["legal", "schema", "file"]) ready(f, svc);
    const { primary: merge } = actions(model(f));
    expect(merge.label).toBe("Merge 2 of 2 approved: legal and schema");
    const binding = bindingSchema.parse(merge.binding);
    expect(binding.verb).toBe(ROLL_OUT.id);
    expect(binding.targets.map((t) => t.repo)).toEqual([
      "Azure/osdu-spi-legal",
      "Azure/osdu-spi-schema",
    ]);
    expect(merge.confirm).toMatchObject({ irreversible: true, subject: "2" });
    expect(merge.confirm?.body).toContain("file merges only after legal and schema");
  });

  test("with one lane free the second merge waits and the button says so", () => {
    const f = settled(fixtureFacts());
    for (const svc of ["legal", "schema"]) ready(f, svc);
    const { primary: merge } = actions(model(f, 1));
    expect(merge.label).toBe("Merge 1 of 2 approved: legal · schema waits for a lane");
    expect(bindingSchema.parse(merge.binding).targets.map((t) => t.label)).toEqual(["legal #33"]);
    expect(merge.confirm?.subject).toBe("1");
  });

  test("without an Environment title stops the line: merges pause and retarget waits", () => {
    const f = settled(fixtureFacts());
    merged(f, "partition", { conclusion: "failure", jobs: [job([])] });
    ready(f, "legal");
    const { primary, secondary } = actions(model(f));
    expect(primary).toEqual({
      type: "act",
      label: "Merging paused · 1 main run red",
      disabled: true,
      reason: "fix it forward in the template",
    });
    expect(secondary.map((a) => [a.label, a.disabled])).toEqual([
      ["Retarget to main · once a template fix merges · main is still bb49a03", true],
    ]);
  });

  test("once a fix lands on main, Retarget dispatches every fork whose PR lacks it", () => {
    const f = settled(fixtureFacts());
    merged(f, "partition", { conclusion: "failure", jobs: [job([])] });
    const old = headSha(f);
    const fix = "f1x0000000000000000000000000000000000001";
    const template = f.github.data?.repos["Azure/osdu-spi"];
    const t = f.template.data;
    if (!template?.head || !t) throw new Error("template");
    template.head = { ...template.head, sha: fix };
    const change = {
      sha: fix,
      title: "fix(acceptance): restore the suite path (#300)",
      pr: 300,
      url: "https://github.com/Azure/osdu-spi/pull/300",
      at: FIXTURE_NOW.toISOString(),
    };
    t.compares[old] = {
      marker: old,
      head: fix,
      label: "v1.2.0 +14",
      aheadBy: 1,
      shas: [fix],
      changes: [change],
    };
    t.compares[fix] = {
      marker: fix,
      head: fix,
      label: "v1.2.0 +15",
      aheadBy: 0,
      shas: [],
      changes: [],
    };
    t.files = { ...(t.files ?? {}), [fix]: ["build/acceptance.Dockerfile"] };
    for (const c of Object.values(t.compares)) {
      if (c.marker === old || c.marker === fix) continue;
      c.shas = [...c.shas, fix];
      c.changes = [change, ...c.changes];
      c.aheadBy += 1;
    }
    const { primary } = actions(model(f));
    expect(primary.label).toMatch(/^Retarget the rollout to main · dispatch partition/);
    const binding = bindingSchema.parse(primary.binding);
    expect(binding.verb).toBe(SYNC_FORKS.id);
    expect(new Set(binding.targets.map((x) => x.sha))).toEqual(new Set([fix]));
  });

  test("with an Environment title on attempt 1 it is re-run once, not a stop", () => {
    const f = settled(fixtureFacts());
    const id = merged(f, "partition", {
      conclusion: "failure",
      jobs: [job(["Shared environment did not answer within 20m"])],
    });
    const { primary: rerun } = actions(model(f));
    expect(rerun.label).toBe("Re-run partition once · environment failure, attempt 1");
    expect(rerun.confirm?.irreversible).toBeUndefined();
    expect(rerun.confirm?.subject).toBeUndefined();
    const binding = bindingSchema.parse(rerun.binding);
    expect(binding.verb).toBe(RERUN_LANES.id);
    expect(binding.targets).toEqual([
      {
        repo: "Azure/osdu-spi-partition",
        kind: "run",
        number: id,
        state: "failure",
        label: "partition main",
      },
    ]);
  });

  test("offers Fleet Release with publish off and no secondary actions", () => {
    const f = doneFacts();
    const { primary: release, secondary } = actions(model(f));
    expect(release.label).toBe("Run Fleet Release · target bb49a03 · publish off");
    const binding = bindingSchema.parse(release.binding);
    expect(binding.verb).toBe(FLEET_RELEASE.id);
    const target = binding.targets[0];
    if (!target) throw new Error("release target");
    expect(commandText(FLEET_RELEASE, target)).toBe(
      `gh workflow run fleet-release.yml -R Azure/osdu-spi -f template_target=${headSha(f)} -f publish=false`,
    );
    expect(release.confirm?.body).toContain("no fleet release is cut");
    expect(release.confirm?.irreversible).toBeUndefined();
    expect(release.confirm?.subject).toBeUndefined();
    expect(secondary).toEqual([]);
  });

  test("pauses every press that deploys and keeps the re-run for after the hold", () => {
    const { primary, secondary } = actions(model(heldFacts()));
    const all = [primary, ...secondary];
    expect(all.every((a) => a.disabled)).toBe(true);
    expect(primary.label).toBe("Waiting for the environment · env-upgrade in verify");
    expect(primary.reason).toBe("merges, dispatches and re-runs resume once it reads deployable");
    expect(all.map((a) => a.label)).toContain(
      "Re-run partition once · after the environment reads deployable",
    );
    expect(all.every((a) => a.reason && !a.confirm && !a.binding)).toBe(true);
  });

  test("dispatches the next forks without calling it a new rollout", () => {
    const m = model(readyFacts());
    if (!m.rollout) throw new Error("rollout");
    m.rollout = { ...m.rollout, next: "dispatch" };
    const { primary } = actions(m);
    expect(primary.label).toBe("Dispatch partition and entitlements");
    expect(bindingSchema.parse(primary.binding).verb).toBe(SYNC_FORKS.id);
    expect(primary.confirm?.body).not.toContain("Upstream sync at");
  });

  test("a start with no available lanes explains unread or busy lanes", () => {
    const m = model(readyFacts());
    if (!m.rollout) throw new Error("rollout");
    m.rollout = {
      ...m.rollout,
      dispatchNext: [],
      lanes: { ...m.rollout.lanes, unread: "legal" },
    };
    expect(actions(m).primary).toMatchObject({
      label: "Start rollout",
      disabled: true,
      reason: "lanes unknown until legal are read",
    });
    m.rollout = { ...m.rollout, lanes: { ...m.rollout.lanes, unread: undefined, busy: 2 } };
    expect(actions(m).primary.reason).toBe("2 of 2 lanes are busy");
  });

  test("an explicit block removes an enabled binding but preserves existing wait reasons", () => {
    const m = model(readyFacts());
    const original = actions(m);
    const blocked = actions(m, "missing repo scope");
    expect(blocked.primary).toEqual({
      type: "act",
      label: original.primary.label,
      disabled: true,
      reason: "missing repo scope",
    });
    expect(blocked.secondary).toEqual(original.secondary);
    expect(actions(model(heldFacts()), "missing repo scope").primary).toEqual(
      actions(model(heldFacts())).primary,
    );
  });

  test("retarget waits for busy lanes instead of offering an empty dispatch", () => {
    const m = model(readyFacts());
    if (!m.rollout) throw new Error("rollout");
    m.rollout = { ...m.rollout, phase: "stopped", next: "retarget" };
    m.lanes = {
      ...m.lanes,
      inflight: ["partition", "entitlements"].map((service) => ({
        repo: `Azure/osdu-spi-${service}`,
        service,
        what: "main Validation running",
      })),
    };
    expect(actions(m).primary).toMatchObject({
      label: "Retarget the rollout to main",
      disabled: true,
      reason: "every lane is busy",
    });
  });
});
