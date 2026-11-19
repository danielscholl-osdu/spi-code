// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Envelope } from "@spi-code/contracts";
import type { Exec } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { fixtureInput } from "../../../test/watch/snapshot-fixture.js";
import { type InspectSnapshot, inspectScope, resolveInspect } from "../../inspect/resolve.js";
import { projectWatch } from "../../watch/project.js";
import { latestSweep, NOT_READ, readState } from "./sweep.js";

const input = fixtureInput();
const snapshot: InspectSnapshot = {
  view: projectWatch(input),
  facts: input.facts,
  releases: { ...input.releases, records: input.releaseRecords },
};
const offline: Exec = {
  runJSON: async () => ({ ok: false, error: "offline", code: 1 }),
  runText: async () => ({ ok: false, error: "offline", code: 1 }),
};
const deps = { ctx: input.context, exec: offline, appData: input.appData };

describe("the latest saved sweep", () => {
  it("answers an id with resolveInspect's result and the inspect row that claimed it", async () => {
    const sweep = latestSweep(() => snapshot, deps)();
    const { model } = inspectScope(snapshot, deps);
    const item = model.queue.items[0]?.id ?? "";
    const fork = model.upstream.forks[0]?.service ?? "";
    for (const [id, kind] of [
      [item, "queue item"],
      [`upstream:${fork}`, "upstream fork"],
    ] as const) {
      const answer = await sweep?.inspect(id);
      expect(answer?.kind).toBe(kind);
      expect(answer?.result).toEqual(await resolveInspect(snapshot, id, deps));
    }
    expect(await sweep?.inspect("nope:1")).toBeUndefined();
    expect(latestSweep(() => undefined, deps)()).toBeUndefined();
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
});
