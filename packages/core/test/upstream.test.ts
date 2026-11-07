// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { flowStatement, upstreamView } from "../src/brief/upstream";
import { builtInFleet, fleetOf } from "../src/config";
import { createContext } from "../src/context";
import type { Facts } from "../src/facts";
import { buildModel, type Model } from "../src/model/index";
import { errorKey, wavesOf } from "../src/model/upstream";
import { parseRollout } from "../src/rollout";
import {
  heldFacts,
  pausedFacts,
  pilotFacts,
  planReadyFacts,
  prepared,
  stoppedFacts,
  templateDone,
  UPSTREAM_NOW,
  UPSTREAM_SERVICES,
  upstreamFacts,
  waveFacts,
} from "./upstream-states";

const fleet = fleetOf(builtInFleet(UPSTREAM_SERVICES));

function modelOf(f: Facts): Model {
  const context = createContext({
    fleet,
    rollout: parseRollout(f.fleet.data?.rollout as string).rollout,
  });
  return buildModel(f, UPSTREAM_NOW, {}, context);
}

function fork(m: Model, service: string) {
  const f = m.upstream.forks.find((x) => x.service === service);
  if (!f) throw new Error(`no ${service}`);
  return f;
}

describe("the plan before anything starts", () => {
  const m = modelOf(planReadyFacts());
  const u = m.upstream;

  test("counts the commits waiting upstream and the forks that move a toolchain", () => {
    expect(u.mode).toBe("planning");
    expect(u.commits).toBe(114);
    expect(u.behind).toBe(13);
    expect(u.moving).toHaveLength(12);
    expect(u.snapshots.map((f) => f.service)).toEqual(["legal"]);
    expect(u.halts.map((f) => f.service)).toEqual(["crs-catalog"]);
  });

  test("pilots the reference fork and every fork with no toolchain move", () => {
    expect(u.pilot).toEqual(["partition", "indexer-queue"]);
    expect(u.gate).toBe("waiting");
  });

  test("sizes waves to the lane cap and keeps search after storage and indexer", () => {
    expect(u.waves.map((w) => w.forks)).toEqual([
      ["entitlements", "schema", "file", "storage", "indexer"],
      ["search", "workflow", "unit", "crs-conversion"],
    ]);
    expect(u.waves[0]?.gate).toBe("partition's cascade is green");
  });

  test("holds the SNAPSHOT move and the coming halt out of every wave", () => {
    expect(u.held.map((f) => [f.service, f.held])).toEqual([
      ["legal", "snapshot"],
      ["crs-catalog", "halt"],
    ]);
    expect(fork(m, "crs-catalog").phase).toBe("halted");
    expect(fork(m, "crs-catalog").wait).toBe("halts on schemathesis-tests; add a filter rule");
  });

  test("reads the lanes the template rollout holds from the same ledger", () => {
    expect(u.lanes.cap).toBe(5);
    expect(u.lanes.busy).toBe(3);
  });
});

describe("waves", () => {
  test("a fork ordered after another waits for a later wave though lanes are free", () => {
    const order = [{ service: "search", after: ["storage"] }];
    expect(wavesOf(["search", "storage", "file"], 5, order)).toEqual([
      ["storage", "file"],
      ["search"],
    ]);
  });

  test("no lane cap puts every fork in one wave", () => {
    expect(wavesOf(["a", "b", "c"], null, [])).toEqual([["a", "b", "c"]]);
  });
});

describe("the pilot in cascade", () => {
  const m = modelOf(pilotFacts());
  const u = m.upstream;

  test("a merged sync PR with its cascade running reads as cascading", () => {
    expect(fork(m, "partition").phase).toBe("cascading");
    expect(fork(m, "indexer-queue").phase).toBe("cascading");
    expect(u.mode).toBe("flight");
  });

  test("a running cascade claims a lane before its Sync to Main opens", () => {
    expect(u.lanes.claims).toBe(2);
  });

  test("wave 1 sync PRs are prepared but Start waits for the pilot's green cascade", () => {
    expect(u.startNext).toEqual([]);
    expect(fork(m, "file").phase).toBe("prepared");
    expect(fork(m, "file").planWait).toBe("wave 1 starts once partition's cascade is green");
  });
});

describe("a wave in progress", () => {
  const m = modelOf(waveFacts());
  const u = m.upstream;

  test("gates come to you as Start and Review", () => {
    expect(u.startNext.map((f) => f.service)).toEqual(["file", "workflow"]);
    expect(u.reviews.map((f) => f.service)).toEqual(["schema"]);
    expect(fork(m, "entitlements").phase).toBe("review");
    expect(fork(m, "entitlements").cells.toMain.text).toBe("testing");
    expect(fork(m, "file").cells.sync.text).toBe("ready");
  });

  test("search waits until storage and indexer are on main", () => {
    expect(fork(m, "search").wait).toBe("after storage, indexer are on main");
  });
});

describe("the same first error", () => {
  test("matches on the message, not the file and position it names", () => {
    const a = "[ERROR] /w/storage/src/StorageAzureConfig.java:[42,8] cannot find symbol: class X";
    const b = "[ERROR] /w/file/src/FileAzureConfig.java:[31,15] cannot find symbol: class X";
    expect(errorKey(a)).toBe("cannot find symbol: class X");
    expect(errorKey(a)).toBe(errorKey(b));
    expect(errorKey("src/Main.java:12: error: package x does not exist")).toBe(
      "package x does not exist",
    );
  });

  test("different messages do not pause the wave", () => {
    expect(modelOf(stoppedFacts()).upstream.paused).toBeUndefined();
  });
});

describe("two forks stopped on the same first error", () => {
  const m = modelOf(pausedFacts());
  const u = m.upstream;

  test("pauses the wave and asks the rest to absorb the move", () => {
    expect(u.paused).toEqual({
      forks: ["file", "storage"],
      error: "cannot find symbol: class TenantFactory",
    });
    expect(u.startNext).toEqual([]);
    expect(fork(m, "workflow").planWait).toBe("the wave is paused: absorb the move first");
  });
});

describe("the environment held", () => {
  const m = modelOf(heldFacts());
  const u = m.upstream;

  test("Start waits, Review and the cascade carry on", () => {
    expect(u.envHeld).toBeDefined();
    expect(u.startNext).toEqual([]);
    expect(fork(m, "file").wait).toBe("the environment is held");
    expect(u.reviews.map((f) => f.service)).toEqual(["schema"]);
  });
});

describe("proof before a step counts", () => {
  test("a Sync to Main merge with no main run read stays on main and keeps its dependents waiting", () => {
    const f = waveFacts();
    const runs = f.runs.data?.["Azure/osdu-spi-partition"];
    if (runs) runs.main = runs.main.filter((r) => r.id < 990_000);
    const m = modelOf(f);
    expect(fork(m, "partition").phase).toBe("main");
    expect(fork(m, "partition").cells.main.text).toBe("waiting");
    expect(m.upstream.done.map((x) => x.service)).toEqual(["indexer-queue"]);
  });

  test("a sync PR with no checks yet does not offer Start", () => {
    const f = templateDone(upstreamFacts());
    prepared(f, "partition");
    const pr = f.github.data?.repos["Azure/osdu-spi-partition"]?.prs.find((p) =>
      p.head.startsWith("sync/upstream-"),
    );
    if (pr) pr.checks = [];
    const m = modelOf(f);
    expect(fork(m, "partition").wait).toBe("its sync PR has no checks yet");
    expect(m.upstream.startNext).toEqual([]);
  });
});

describe("the flight headline", () => {
  test("a gate list too long for the headline names the first and leads sub whole", () => {
    const u = modelOf(stoppedFacts()).upstream;
    const view = upstreamView(u, UPSTREAM_NOW);
    const whole =
      "4 gates wait on you: start file, start workflow, re-run storage's cascade, review schema.";
    expect(view.headline).toBe("4 gates wait on you: start file and 3 more.");
    expect(view.sub.startsWith(whole)).toBe(true);
    expect(flowStatement(u)).toBe(whole);
  });

  test("a statement that would push the headline past 12 words moves to sub", () => {
    const u = modelOf(pilotFacts()).upstream;
    const view = upstreamView(u, UPSTREAM_NOW);
    expect(view.headline).toBe("Partition and indexer-queue are in cascade; nothing waits on you.");
    expect(view.sub.startsWith("0 of 13 forks are on main.")).toBe(true);
    expect(flowStatement(u)).toBe(`${view.headline} 0 of 13 forks are on main.`);
  });
});
