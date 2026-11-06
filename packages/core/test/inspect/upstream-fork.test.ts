// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { afterAll, describe, expect, test, vi } from "vitest";
import { builtInFleet, fleetOf } from "../../src/config.js";
import { createContext } from "../../src/context.js";
import type { Facts } from "../../src/facts.js";
import { inspectUpstreamFork } from "../../src/inspect/upstream-fork.js";
import type { UpstreamBoardOptions } from "../../src/inspect/upstream-shared.js";
import { buildModel, type Model } from "../../src/model/index.js";
import { parseRollout } from "../../src/rollout.js";
import { RIB_VOICE } from "../../src/voice.js";
import {
  planReadyFacts,
  UPSTREAM_NOW,
  UPSTREAM_SERVICES,
  UPSTREAM_STATES,
  upstreamFacts,
  waveFacts,
} from "../upstream-states.js";

vi.stubEnv("TZ", "UTC");
afterAll(() => vi.unstubAllEnvs());

const BLOCKED: UpstreamBoardOptions = {
  blocked: "read-only token",
  extra: [{ kind: "rows", title: "Last action", items: [{ text: "x" }] }],
};

const states: Record<string, { facts: () => Facts; opts?: UpstreamBoardOptions }> = {
  ...Object.fromEntries(Object.entries(UPSTREAM_STATES).map(([name, facts]) => [name, { facts }])),
  "upstream-unread": {
    facts: () => {
      const f = upstreamFacts();
      f.upstream = { ...f.upstream, data: undefined };
      return f;
    },
  },
  "current-and-unread": {
    facts: () => {
      const f = planReadyFacts();
      const data = f.upstream.data as NonNullable<Facts["upstream"]["data"]>;
      data.partition = {
        ...(data.partition as NonNullable<typeof data.partition>),
        commits: [],
        lag: 0,
      };
      data.unit = { ...(data.unit as NonNullable<typeof data.unit>), commits: [], lag: 0 };
      delete data.legal;
      return f;
    },
  },
  "blocked-plus-extra": { facts: waveFacts, opts: BLOCKED },
};

// Captured from the pinned rib's upstreamForkBoard for every fork, in fork order, from identical Facts.
const hashes: Record<string, string> = {
  "plan-ready": "7e5fb4a8fca5d51f5c5691c5804dda350a470e40f0ffd4fc8debea7587930bff",
  "pilot-cascade": "e9126d1c1150de43418b17a3ae8b1bb585a154a9a02e463ef22a3c4d706f839b",
  "wave-gates": "d1387012add5b904f7db38f05aa19dd53561c7515798ddcb878a76c9a06ed257",
  "fork-stopped": "cd83ea533d129fd55d8deb0a3d366d2c2ab1923bbb9834a8c41edd0e4562649a",
  "same-cause": "bf1bc3af7041a14632a25bb14ec579dedd51ee5a0f245796c1e703dde89aabb0",
  "env-held": "02f8d1a065c9a45fd289980cefbf81e1e5b33d2b8258e8a35d56ba56b1bc29d3",
  "upstream-unread": "9efb0aeeed2e8a6d7ffc4da8485180833f98d2ec1cedb9b0d3fc0a2d16517bd7",
  "current-and-unread": "cc8f7545a67d08849483f86caa93474e5b0da3b24013bdeb1ed237bc776749f8",
  "blocked-plus-extra": "83b57cc52cd0d8f02a6421e04dd0a9ed62c5e77f93e625e357e16bae1e3459e7",
};

function modelOf(facts: Facts): Model {
  const context = createContext({
    fleet: fleetOf(builtInFleet(UPSTREAM_SERVICES)),
    rollout: parseRollout(facts.fleet.data?.rollout as string).rollout,
    clock: { now: () => UPSTREAM_NOW },
  });
  return buildModel(facts, UPSTREAM_NOW, {}, context);
}

const cases = Object.entries(states).map(([name, { facts, opts }]) => {
  const model = modelOf(facts());
  const boards = model.upstream.forks.map((f) =>
    inspectUpstreamFork(model, f.service, UPSTREAM_NOW, { ...opts, voice: RIB_VOICE }),
  );
  return { name, model, boards };
});

function board(name: string, service: string) {
  const scenario = cases.find((c) => c.name === name);
  const index = scenario?.model.upstream.forks.findIndex((f) => f.service === service) ?? -1;
  const found = scenario?.boards[index];
  if (!found) throw new Error(`Missing ${name}/${service}`);
  return found;
}

describe("pinned rib upstream-fork parity", () => {
  test.each(cases)(
    "$name matches every rib fork board from identical Facts",
    ({ name, boards }) => {
      expect(createHash("sha256").update(JSON.stringify(boards)).digest("hex")).toBe(hashes[name]);
    },
  );

  test("a stopped cascade says what failed, with no action on that card", () => {
    const b = board("fork-stopped", "storage");
    expect(b.header.status).toEqual({ label: "P1 · CASCADE STOPPED", tone: "error" });
    const failed = b.sections.find((s) => s.title === "What failed");
    if (failed?.kind !== "cards") throw new Error("Missing What failed");
    expect(failed.items[0]?.actions).toBeUndefined();
    expect(failed.items[0]?.fields.map((f) => f.label)).toContain("First error");
  });

  test("held forks name their hold, and the next step comes back to the plan", () => {
    const legal = board("wave-gates", "legal");
    expect(legal.header.status.label).toBe("PREPARED");
    expect(legal.header.chip).toContain("legal");
    const halted = board("plan-ready", "crs-catalog");
    expect(halted.header.status).toEqual({ label: "SYNC HALTS", tone: "error" });
    expect(halted.sections.at(-1)).toEqual({
      kind: "rows",
      items: [
        {
          text: "Back to the upstream plan",
          action: { type: "inspect", payload: { id: "upstream" } },
        },
      ],
    });
  });

  test("current and unread forks read as such", () => {
    expect(board("current-and-unread", "partition").header.status.label).toBe("CURRENT");
    expect(board("current-and-unread", "legal").header.status.label).toBe("UNREAD");
    expect(board("upstream-unread", "file").header.status.label).toBe("UNREAD");
  });

  test("by default every fork board names SPI Code where the rib named itself", () => {
    const text = cases
      .flatMap(({ name, model }) =>
        model.upstream.forks.map((f) =>
          JSON.stringify(inspectUpstreamFork(model, f.service, UPSTREAM_NOW, states[name]?.opts)),
        ),
      )
      .join("\n");
    expect(text).not.toMatch(/\b[Rr]ib\b/);
    for (const said of [
      "SPI Code never approves.",
      "SPI Code pauses the wave",
      "SPI Code shows it as Prepared",
    ])
      expect(text).toContain(said);
  });

  test("an unknown or inexact service has no board", () => {
    const { model } = cases[0] as (typeof cases)[number];
    for (const service of ["", "nope", "Partition", " partition", "__proto__", "partition/x"]) {
      expect(inspectUpstreamFork(model, service, UPSTREAM_NOW)).toBeUndefined();
    }
  });
});
