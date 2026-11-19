// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope } from "@spi-code/contracts";
import type { Exec } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { fixtureInput } from "../../../test/watch/snapshot-fixture.js";
import { type InspectSnapshot, inspectScope, resolveInspect } from "../../inspect/resolve.js";
import { projectWatch } from "../../watch/project.js";
import { chipFromSweep } from "./draft.js";
import { latestSweep, NOT_READ, readState, withRecords } from "./sweep.js";

const input = fixtureInput();
const snapshot: InspectSnapshot = {
  view: projectWatch(input),
  facts: input.facts,
  releases: { ...input.releases, records: input.releaseRecords },
};
const saved = { ...snapshot, reads: { ...input.reads, releases: input.releaseRecords } };
let forgeCalls = 0;
const forge: Exec = {
  runJSON: async () => {
    forgeCalls += 1;
    return { ok: false, error: "offline", code: 1 };
  },
  runText: async () => {
    forgeCalls += 1;
    return { ok: false, error: "offline", code: 1 };
  },
};
const deps = { ctx: input.context, exec: forge, appData: input.appData };
const { exec: _forge, ...savedOnly } = deps;

describe("the latest saved sweep", () => {
  it("answers an id with the saved-only resolver's result and the inspect row that claimed it", async () => {
    const sweep = latestSweep(() => saved, deps)();
    const { model } = inspectScope(snapshot, deps);
    const item = model.queue.items[0]?.id ?? "";
    const fork = model.upstream.forks[0]?.service ?? "";
    for (const [id, kind] of [
      [item, "queue item"],
      [`upstream:${fork}`, "upstream fork"],
    ] as const) {
      const answer = await sweep?.inspect(id);
      expect(answer?.kind).toBe(kind);
      expect(answer?.result).toEqual(await resolveInspect(snapshot, id, savedOnly));
    }
    expect(await sweep?.inspect("nope:1")).toBeUndefined();
    expect(latestSweep(() => undefined, deps)()).toBeUndefined();
  });

  it("inspects and packs a checkable halt from the saved sweep alone, with its time", async () => {
    forgeCalls = 0;
    await resolveInspect(snapshot, "halt:entitlements", deps);
    expect(forgeCalls).toBeGreaterThan(0);

    forgeCalls = 0;
    const latest = latestSweep(() => saved, deps);
    const answer = await latest()?.inspect("halt:entitlements");
    const plain = { text: (text: string) => text, value: <T>(value: T) => value };
    const chip = await chipFromSweep(latest, "halt:entitlements", plain);
    expect(forgeCalls).toBe(0);
    expect(answer?.result.notRead).toContain("Whether the other forks carry the same entry");
    expect(answer?.result.evidence).toEqual([]);
    expect(chip.ok && chip.chip.chip.sweptAt).toBe(snapshot.view.sweptAt);
  });
});

const at = "2026-11-06T14:02:00.000Z";
const envelope = (state: Envelope["state"], observed = true): Envelope =>
  state === "unread"
    ? { source: "radar", state }
    : {
        source: "radar",
        state,
        completeness: { kind: "complete" },
        ...(observed ? { observedAt: at } : {}),
      };

describe("an area's read state", () => {
  it.each([
    ["nothing", NOT_READ, [], [], []],
    ["an unread area", NOT_READ, [envelope("unread")], ["radar"], []],
    ["a failed read with nothing retained", NOT_READ, [envelope("failed", false)], ["radar"], []],
    [
      "a failed read with an earlier one retained",
      "partly read",
      [envelope("failed")],
      [],
      ["radar"],
    ],
    [
      "one fresh and one unread",
      "partly read",
      [envelope("fresh"), envelope("unread")],
      ["radar"],
      [],
    ],
    ["a fresh read", "read", [envelope("fresh")], [], []],
  ] as const)("reads %s as %s", (_name, read, envelopes, notRead, failed) => {
    const state = readState(envelopes.map((entry) => ({ area: "radar", envelope: entry })));
    expect(state).toMatchObject({ read, notRead, failed });
  });

  it("splits a failed area by its own records, keeping each retained read's original time", () => {
    const earlier = "2026-11-05T09:00:00.000Z";
    const record = { source: "Azure/osdu-spi-unit", object: "filter", observedAt: at };
    const complete = { completeness: { kind: "complete" as const } };
    const radar = [
      { ...record, ...complete },
      { ...record, ...complete, failure: "HTTP 504", retainedFrom: earlier },
      { ...record, ...complete, failure: "HTTP 504" },
    ];
    const areas = [
      { area: "radar", state: "failed" as const, observedAt: earlier },
      { area: "upstream", state: "fresh" as const, observedAt: at },
      { area: "template", state: "failed" as const },
      { area: "lifecycle", state: "failed" as const },
    ];
    expect(withRecords(areas, { radar, lifecycle: [] })).toEqual([
      { ...areas[0], records: { read: 1, retained: [{ from: earlier, reads: 1 }], lost: 1 } },
      areas[1],
      { ...areas[2], records: NOT_READ },
      { ...areas[3], records: NOT_READ },
    ]);
  });
});
