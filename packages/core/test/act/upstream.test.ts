// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { loadSources, reasonSources } from "../../src/act/reason-sources.js";
import { forkActions, planActions, upstreamVerbs } from "../../src/act/upstream.js";
import { DISPATCH_CASCADE, PREPARE, RERUN_CASCADE, START } from "../../src/act/upstream-targets.js";
import {
  type ActionItem,
  bindingSchema,
  commandText,
  createRegistry,
} from "../../src/act/verbs.js";
import { builtInFleet, fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { Facts } from "../../src/facts.js";
import { buildModel, type Model } from "../../src/model/index.js";
import { parseRollout } from "../../src/rollout.js";
import {
  envHeld,
  heldFacts,
  pausedFacts,
  planReadyFacts,
  prepared,
  stoppedFacts,
  UPSTREAM_NOW,
  UPSTREAM_SERVICES,
  UPSTREAM_STATES,
  upstreamFacts,
  waveFacts,
} from "../upstream-states.js";

function modelOf(f: Facts): Model {
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

function fork(m: Model, service: string) {
  const f = m.upstream.forks.find((x) => x.service === service);
  if (!f) throw new Error(`no ${service}`);
  return f;
}

function opts(m: Model) {
  return { swept: m.sweptAt ?? "", load: m.lanes, now: UPSTREAM_NOW };
}

function binding(a: ActionItem) {
  expect(a.disabled).toBeUndefined();
  expect(a.reason).toBeUndefined();
  expect(a.confirm).toBeDefined();
  return bindingSchema.parse(a.binding);
}

describe("upstream planning", () => {
  test("the primary press prepares the pilot and nothing merges", () => {
    const m = modelOf(planReadyFacts());
    const a = planActions(m.upstream, opts(m));
    const b = binding(a.primary);
    expect(b.item).toBe("upstream");
    expect(b.verb).toBe(PREPARE.id);
    expect(b.targets.map((t) => t.label)).toEqual(["partition", "indexer-queue"]);
    const t = b.targets[0];
    if (!t) throw new Error("fixture has a pilot");
    expect(commandText(PREPARE, t)).toBe("gh workflow run sync.yml -R Azure/osdu-spi-partition");
    expect(a.primary.confirm?.body).toContain("Nothing merges, and no lane is taken.");
  });

  test("a template rollout PR still open keeps Start off the fork", () => {
    const f = upstreamFacts();
    prepared(f, "partition");
    const m = modelOf(f);
    expect(fork(m, "partition").wait).toContain("template");
    expect(forkActions(m.upstream, fork(m, "partition"), opts(m)).primary.disabled).toBe(true);
  });

  test("Start merges the sync PR, then dispatches the cascade with its tracking issue", () => {
    const m = modelOf(waveFacts());
    const b = binding(planActions(m.upstream, opts(m)).primary);
    expect(b.verb).toBe(START.id);
    expect(b.targets.map((t) => t.label.split(" ")[0])).toEqual(["file", "workflow"]);
    const t = b.targets[0];
    if (!t) throw new Error("fixture has a Start target");
    expect(commandText(START, t)).toBe(
      `gh pr merge ${t.number} -R Azure/osdu-spi-file --merge && gh workflow run cascade.yml -R Azure/osdu-spi-file -f issue_number=${t.issue}`,
    );
  });

  test("Review is a link, never a verb", () => {
    const m = modelOf(waveFacts());
    const a = forkActions(m.upstream, fork(m, "schema"), opts(m));
    expect(a.primary).toEqual({
      type: "act",
      label: "Nothing to press",
      disabled: true,
      reason: "the Sync to Main PR auto-merges when green",
    });
    expect(a.secondary).toEqual([]);
  });

  test("a stopped cascade waits for a fix on fork_integration before Re-run", () => {
    const m = modelOf(waveFacts());
    const s = fork(m, "storage");
    expect(s.stop?.fixLanded).toBe(false);
    expect(forkActions(m.upstream, s, opts(m)).primary.disabled).toBe(true);
  });

  test("Re-run dispatches the cascade again with the tracking issue", () => {
    const m = modelOf(stoppedFacts());
    const s = fork(m, "storage");
    const b = binding(forkActions(m.upstream, s, opts(m)).primary);
    expect(b.item).toBe("upstream:storage");
    expect(b.verb).toBe(RERUN_CASCADE.id);
    expect(b.targets[0]?.issue).toBe(s.tracking?.number);
  });

  test("a landed fix does not open Re-run while the environment is held", () => {
    const m = modelOf(heldFacts());
    const s = fork(m, "storage");
    expect(s.stop?.fixLanded).toBe(true);
    expect(m.upstream.reruns).toEqual([]);
    const own = forkActions(m.upstream, s, opts(m)).primary;
    expect(own.disabled).toBe(true);
    expect(own.label).toBe("Re-run the cascade · the environment is held");
    expect(planActions(m.upstream, opts(m)).secondary.map((a) => a.label)).toContain(
      "Re-run storage's cascade · the environment is held",
    );
  });

  test("Prepare is not gated on the environment", () => {
    const m = modelOf(envHeld(planReadyFacts()));
    expect(m.upstream.envHeld).toBeDefined();
    const a = forkActions(m.upstream, fork(m, "partition"), opts(m));
    expect(binding(a.primary).verb).toBe(PREPARE.id);
  });

  test("global blocking strips live bindings and confirmations but preserves existing waits", () => {
    const m = modelOf(waveFacts());
    const open = planActions(m.upstream, opts(m));
    const blocked = planActions(m.upstream, { ...opts(m), blocked: "no repo scope" });
    expect(blocked.secondary).toHaveLength(open.secondary.length);
    for (const [i, a] of [open.primary, ...open.secondary].entries()) {
      const off = [blocked.primary, ...blocked.secondary][i];
      expect(off).toEqual(
        a.disabled
          ? a
          : {
              type: "act",
              label: a.label,
              disabled: true,
              reason: "no repo scope",
            },
      );
    }
    const own = forkActions(m.upstream, fork(m, "file"), { ...opts(m), blocked: "no repo scope" });
    expect(own.primary.reason).toBe("no repo scope");
    expect(own.primary.binding).toBeUndefined();
    expect(own.primary.confirm).toBeUndefined();
  });
});

describe("upstream reason sources", () => {
  function everyAction(m: Model, extra: { blocked?: string } = {}) {
    const o = { ...opts(m), ...extra };
    return [
      planActions(m.upstream, o),
      ...m.upstream.forks.map((f) => forkActions(m.upstream, f, o)),
    ].flatMap((a) => [a.primary, ...a.secondary]);
  }

  test("every disabled reason in every recorded state names the reads it rests on", () => {
    let reasons = 0;
    for (const [state, facts] of Object.entries(UPSTREAM_STATES)) {
      for (const a of everyAction(modelOf(facts()))) {
        const from = reasonSources(a);
        if (a.reason) {
          reasons++;
          expect(from, `${state}: ${a.label}`).toBeDefined();
          expect(from?.length, `${state}: ${a.label}`).toBeGreaterThan(0);
        } else {
          expect(from, `${state}: ${a.label}`).toBeUndefined();
        }
      }
    }
    expect(reasons).toBeGreaterThan(10);
  });

  test("each wait cites only the branch that read it", () => {
    const tmpl = upstreamFacts();
    prepared(tmpl, "partition");
    const t = modelOf(tmpl);
    expect(reasonSources(forkActions(t.upstream, fork(t, "partition"), opts(t)).primary)).toEqual([
      "github",
    ]);

    const w = modelOf(waveFacts());
    const storage = forkActions(w.upstream, fork(w, "storage"), opts(w)).primary;
    expect(storage.reason).toBe("once a fix lands on fork_integration");
    expect(reasonSources(storage)).toEqual(["runs"]);
    expect(reasonSources(forkActions(w.upstream, fork(w, "schema"), opts(w)).primary)).toEqual([
      "github",
    ]);

    const h = modelOf(heldFacts());
    const held = forkActions(h.upstream, fork(h, "storage"), opts(h)).primary;
    expect(held.reason).toBe("the environment is held");
    expect(reasonSources(held)).toEqual(["lifecycle"]);
    const plan = planActions(h.upstream, opts(h));
    const rerun = plan.secondary.find((a) => a.label.startsWith("Re-run storage's"));
    expect(reasonSources(rerun ?? plan.primary)).toEqual(["lifecycle"]);

    const p = modelOf(pausedFacts());
    const paused = planActions(p.upstream, opts(p)).primary;
    expect(paused.label).toMatch(/^Paused · /);
    expect(reasonSources(paused)).toEqual(["runs"]);

    const r = modelOf(planReadyFacts());
    const halted = r.upstream.forks.find((f) => f.phase === "halted" && !f.halt?.open);
    if (!halted) throw new Error("fixture has an unopened halt");
    expect(reasonSources(forkActions(r.upstream, halted, opts(r)).primary)).toEqual(["radar"]);
  });

  test("a lane wait cites the lane reads", () => {
    const m = modelOf(waveFacts());
    const unread = { ...m.lanes, unread: "fork workflow runs" };
    const own = forkActions(m.upstream, fork(m, "file"), { ...opts(m), load: unread }).primary;
    expect(own.reason).toBe("lanes unknown until fork workflow runs are read");
    expect(reasonSources(own)).toEqual(["runs"]);
    expect(reasonSources(own)).toEqual(loadSources(unread));
  });

  test("a scope block cites no reads and leaves existing waits their own", () => {
    const m = modelOf(waveFacts());
    const open = everyAction(m);
    const blocked = everyAction(m, { blocked: "no repo scope" });
    expect(blocked.some((a) => a.reason === "no repo scope")).toBe(true);
    for (const [i, a] of blocked.entries()) {
      const was = open[i];
      if (!was) throw new Error("same actions either way");
      expect(reasonSources(a)).toEqual(was.disabled ? reasonSources(was) : []);
    }
  });
});

test("upstream verbs register only in the supplied registry and retain pacing", () => {
  const registry = createRegistry();
  const other = createRegistry();
  upstreamVerbs(registry);
  for (const verb of [PREPARE, START, DISPATCH_CASCADE, RERUN_CASCADE]) {
    expect(registry.verbOf(verb.id)).toBe(verb);
    expect(other.verbOf(verb.id)).toBeUndefined();
    expect(verb.paced === true).toBe(verb !== PREPARE);
  }
  upstreamVerbs(other);
  expect(other.verbOf(START.id)).toBe(START);
});
