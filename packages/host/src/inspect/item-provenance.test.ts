// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AREAS, type ValueSource } from "@spi-code/contracts";
import {
  buildModel,
  builtInFleet,
  createContext,
  type Exec,
  emptyFacts,
  type Facts,
  fleetOf,
  itemEvidence,
  type QueueItem,
} from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { fixtureInput } from "../../test/watch/snapshot-fixture.js";
import { projectWatch } from "../watch/project.js";
import { inspectResult } from "./item.js";

const SWEEP_1116_NOW = new Date("2026-11-17T01:06:12.682Z");
const fixtureRoot = new URL("../../../core/test/fixtures/", import.meta.url);
const base = fixtureInput();
const input = {
  ...base,
  facts: {
    ...emptyFacts(),
    ...JSON.parse(readFileSync(new URL("upstream-1116.json", fixtureRoot), "utf8")),
  } as Facts,
  context: createContext({
    fleet: fleetOf(builtInFleet(fileURLToPath(new URL("upstream-services.json", fixtureRoot)))),
    ...(base.context.rollout ? { rollout: base.context.rollout } : {}),
    clock: { now: () => SWEEP_1116_NOW },
  }),
};
const model = buildModel(input.facts, SWEEP_1116_NOW, {}, input.context);
const snapshot = projectWatch(input);
const exec: Exec = {
  runJSON: async () => ({ ok: false, error: "offline", code: 1 }),
  runText: async () => ({ ok: false, error: "offline", code: 1 }),
};
const item = (id: string) => {
  const found = model.queue.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`Missing fixture item ${id}`);
  return found;
};
const inspect = (entry: QueueItem) =>
  inspectResult(model, entry, SWEEP_1116_NOW, input.context, exec, snapshot.areas);
const binding = ({ areas, attributed }: ValueSource) => ({ areas, attributed });

describe("item evidence on the 16 Nov shapes", () => {
  it.each([
    ["gate2:storage", ["Validation Summary job"]],
    ["lane-deploy:partition", ["Deployment failure's cause"]],
    ["gate2:legal", ["Whether the other lanes have drained"]],
    ["gate2:indexer-queue", ["Whether the other lanes have drained"]],
    ["gate2:entitlements", ["Whether the other lanes have drained"]],
    ["gate2:indexer", ["Whether the other lanes have drained"]],
    ["gate1:unit", []],
  ])("names the reads not made for %s", async (id, notRead) => {
    expect((await inspect(item(id as string))).notRead).toEqual(notRead);
  });

  it.each([
    ["gate2:storage", ["github", "details"]],
    ["lane-deploy:partition", ["github", "lifecycle"]],
    ["gate2:legal", ["github", "lifecycle", "details"]],
    ["gate1:unit", ["github", "upstream"]],
    ["sync-run:indexer", ["github", "runs"]],
  ])("narrows %s to the areas feeding its facts", async (id, areas) => {
    const result = await inspect(item(id as string));
    expect(result.provenance?.length).toBeGreaterThan(0);
    expect(result.provenance?.map(binding)).toEqual(
      result.provenance?.map(() => ({ areas, attributed: "item" })),
    );
  });

  it("does not guess an attribution when an item or its underlying PR is missing", async () => {
    expect(itemEvidence(model, ["missing"])).toMatchObject({ attributed: "sweep", notRead: [] });
    const line = model.lines.find((line) => line.fork.id === "unit");
    if (!line) throw new Error("Missing unit line");
    const missingPr = {
      ...model,
      lines: model.lines.map((entry) => {
        if (entry !== line) return entry;
        const { syncPr: _syncPr, ...rest } = entry;
        return rest;
      }),
    };
    expect(itemEvidence(missingPr, ["gate1:unit"])).toMatchObject({ attributed: "sweep" });
  });

  it("stops reporting a missing job when core has read it", () => {
    const facts = structuredClone(input.facts);
    const line = model.lines.find((line) => line.fork.id === "storage");
    const check = line?.cascadePr?.pr.checks.find((check) => check.name === "Validation Summary");
    if (!line || !check || !facts.details.data) throw new Error("Missing storage check");
    facts.details.data[`${line.fork.repo}#${check.id}`] = {
      id: check.id,
      name: check.name,
      status: "completed",
      steps: [],
      conclusion: "failure",
      failedStep: "Summarize",
      reason: "A required job did not finish",
      url: check.url ?? "",
    };
    const read = buildModel(facts, SWEEP_1116_NOW, {}, input.context);
    expect(itemEvidence(read, ["gate2:storage"]).notRead).toEqual([]);
  });

  it("keeps an unattributable item explicitly at sweep scope", async () => {
    const result = await inspect(item("rollout"));
    const areas = AREAS.filter((area) => area !== "fleet" && area !== "auth");
    expect(result.provenance?.map(binding)).toEqual(
      result.provenance?.map(() => ({ areas, attributed: "sweep" })),
    );
    expect(result.provenance?.length).toBeGreaterThan(0);
  });

  it("uses the same attribution for inspect and every briefing item, including folded items", async () => {
    for (const list of ["focus", "rest"] as const) {
      for (const [index, entry] of snapshot.briefing[list].entries()) {
        const source = snapshot.provenance.find(
          ({ path }) => path === `/briefing/${list}/${index}`,
        );
        expect(source).toBeDefined();
        const members = await Promise.all(entry.ids.map((id) => inspect(item(id))));
        const areas = AREAS.filter((area) =>
          members.some((member) => member.provenance?.some((p) => p.areas.includes(area))),
        );
        expect(source?.areas, entry.id).toEqual(areas);
        expect(source?.attributed, entry.id).toBe(
          members.some((member) => member.provenance?.some((p) => p.attributed === "sweep"))
            ? "sweep"
            : "item",
        );
      }
    }
  });
});
