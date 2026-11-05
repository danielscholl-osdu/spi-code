// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "vitest";
import { buildBriefing } from "../src/brief/index";
import { nextWhy, upstreamPrs, watchText } from "../src/brief/rollout";
import type { Facts } from "../src/facts";
import { buildModel } from "../src/model/index";
import { upstreamOpens } from "../src/model/rollout";
import { parseRollout, useRollout } from "../src/rollout";
import { plural } from "../src/util";
import {
  doneFacts,
  environmentFacts,
  heldFacts,
  job,
  merged,
  ready,
  readyFacts,
  rollingFacts,
  settled,
  stoppedFacts,
} from "./flow-states";
import { FIXTURE_NOW, fixtureFacts } from "./harness";
import "./briefing-setup";

afterEach(() => useRollout(undefined));

describe("a change only on main", () => {
  test("raises a P1 Rollout item with the plan, the reach and the schedule", () => {
    useRollout(
      parseRollout(
        JSON.stringify({
          schema: 1,
          lanes: 2,
          ordering: [{ service: "file", after: ["legal", "schema"] }],
        }),
      ).rollout,
    );
    const m = buildModel(readyFacts(), FIXTURE_NOW);
    expect(m.rollout).toMatchObject({ phase: "ready", next: "start", total: 5, merged: 0 });
    const item = m.queue.items.find((i) => i.id === "rollout");
    expect(item).toMatchObject({ rung: 1, cls: "ROLLOUT", scope: "fleet" });
    expect(m.queue.items.some((i) => i.id === "template-set")).toBe(false);
    const b = buildBriefing(m, { state: "clear", problems: [] }, FIXTURE_NOW);
    const focus = b.focus.find((f) => f.id === "rollout");
    expect(focus?.verb).toBe("Start rollout");
    expect(focus?.next).toBe("Start the rollout: dispatch Sync Template to the first 2 forks.");
    expect(focus?.more?.find((x) => x.label === "Plan")?.text).toBe(
      "3 waves · lanes 2 from rollout.json · file merges after legal and schema",
    );
    expect(focus?.more?.map((x) => x.label)).toEqual(["Plan", "Watch", "Reaches"]);
  });
});

describe("a main run that fails after its merge", () => {
  test("an Environment title on a second attempt stops the line", () => {
    const f = settled(fixtureFacts());
    merged(f, "partition", { conclusion: "failure", attempt: 2, jobs: [job(["timeout"], 2)] });
    expect(buildModel(f, FIXTURE_NOW).rollout?.phase).toBe("stopped");
  });
});

describe("every fork on the change", () => {
  function done(ago = 60) {
    const f = settled(fixtureFacts());
    for (const svc of ["partition", "entitlements", "legal", "schema", "file"]) {
      merged(f, svc, {}, ago);
    }
    return f;
  }

  test("a day after the last merge the item leaves the queue", () => {
    expect(buildModel(done(25 * 60), FIXTURE_NOW).rollout).toBeUndefined();
  });
});

describe("the rollout file's ordering", () => {
  test("a rule the rib cannot read is dropped with a warning", () => {
    const parsed = parseRollout(
      JSON.stringify({ schema: 1, lanes: 5, ordering: [{ service: "search", after: "storage" }] }),
    );
    expect(parsed.rollout).toEqual({ lanes: 5 });
    expect(parsed.warnings[0]).toContain("an ordering rule the rib cannot read");
  });
});

describe("the states dev/states.ts replays", () => {
  test("each lands in the phase and next press it is named for", () => {
    useRollout({ lanes: 2, ordering: [{ service: "file", after: ["legal", "schema"] }] });
    const phase = (f: Facts) => {
      const r = buildModel(f, FIXTURE_NOW).rollout;
      return [r?.phase, r?.next];
    };
    expect(phase(readyFacts())).toEqual(["ready", "start"]);
    expect(phase(rollingFacts())).toEqual(["rolling", "merge"]);
    expect(phase(stoppedFacts())).toEqual(["stopped", "stopped"]);
    expect(phase(environmentFacts())).toEqual(["rolling", "rerun"]);
    expect(phase(heldFacts())).toEqual(["rolling", "env"]);
    expect(phase(doneFacts())).toEqual(["done", "release"]);
  });
});

describe("a held environment", () => {
  test("an approved PR waits on the environment, not on the next press", () => {
    const f = heldFacts();
    ready(f, "legal");
    const m = buildModel(f, FIXTURE_NOW);
    expect(m.rollout?.next).toBe("env");
    expect(m.rollout?.forks.find((x) => x.service === "legal")?.merge).toMatchObject({
      text: "env",
      note: "merges once the environment is deployable",
    });
  });
});

describe("the words around a rollout", () => {
  test("an upstream sync that only halts says so instead of nothing queued", () => {
    const r = buildModel(readyFacts(), FIXTURE_NOW).rollout as NonNullable<
      ReturnType<typeof buildModel>["rollout"]
    >;
    const only = {
      ...r,
      schedule: {
        ...r.schedule,
        upstreamForks: 0,
        upstreamMaybe: 0,
        upstreamHalts: ["entitlements"],
      },
    };
    expect(upstreamPrs(only)).toBe("no PR (entitlements halts instead)");
    expect(watchText(only, FIXTURE_NOW)).toMatch(
      /^Upstream sync at 10-13 00:00 opens no PR \(entitlements halts instead\)\. /,
    );
  });

  test("a sync is filtered-only by its queued commits, not by open upstream MRs", () => {
    const m = buildModel(readyFacts(), FIXTURE_NOW);
    const line = m.lines.find((l) => l.fork.id === "legal");
    if (!line) throw new Error("legal line");
    const filtered = { bucket: "Filtered" as const, paths: ["docs/a.md"] };
    const shared = { bucket: "Shared" as const, paths: ["pom.xml"] };
    const radar = (certain: (typeof filtered)[], possible: (typeof shared)[]) => ({
      services: {
        legal: { state: "clean" as const, queued: 1, mrs: 1, certain, possible },
      },
    });
    expect(upstreamOpens([line], radar([filtered], [shared]))).toEqual({
      upstreamForks: 1,
      upstreamMaybe: 1,
      upstreamHalts: [],
    });
  });

  test("the rollout's fingerprint tells an owed re-run from an unjudged environment failure", () => {
    const inputs = (f: Facts) =>
      buildModel(f, FIXTURE_NOW).queue.items.find((i) => i.id === "rollout")?.inputs ?? [];
    const owed = inputs(environmentFacts()).find((x) => x.startsWith("partition:"));
    const unjudged = inputs(heldFacts()).find((x) => x.startsWith("entitlements:"));
    expect(owed).toContain(":rerun");
    expect(unjudged).not.toContain(":rerun");
    expect(unjudged).toContain("Validation failed on the environment's own hold");
  });

  test("the upstream sync counts only the forks it opens a PR on", () => {
    const r = buildModel(readyFacts(), FIXTURE_NOW).rollout;
    expect(r?.schedule).toMatchObject({ upstreamHalts: ["entitlements"] });
    expect(upstreamPrs(r as NonNullable<typeof r>)).toBe(
      `${plural(r?.schedule.upstreamForks ?? 0, "PR")} (entitlements halts instead)`,
    );
  });

  test("the evidence leads with main's sha and how far the forks trail it", () => {
    const m = buildModel(readyFacts(), FIXTURE_NOW);
    const b = buildBriefing(m, { state: "clear", problems: [] }, FIXTURE_NOW);
    const evidence = b.focus.find((f) => f.id === "rollout")?.evidence.map((e) => e.label);
    expect(evidence?.slice(0, 2)).toEqual(["main c0de000", "forks on ea9a2e1"]);
  });

  test("a fork whose name ends in s takes a bare apostrophe", () => {
    const m = buildModel(stoppedFacts(), FIXTURE_NOW);
    expect(nextWhy(m.rollout as NonNullable<typeof m.rollout>)).toMatch(
      /^entitlements' main run failed after its merge\./,
    );
  });
});
