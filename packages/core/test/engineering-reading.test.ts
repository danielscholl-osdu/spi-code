// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBriefing } from "../src/brief/index.js";
import { builtInFleet, fleetOf, TEMPLATE_REPO } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { ReadRecord } from "../src/evidence/index.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { factsSchema } from "../src/facts-schema.js";
import { buildModel } from "../src/model/index.js";
import { type EngineeringItem, engineeringReading } from "../src/readings/engineering.js";
import { internalNames, NOT_READ, readingText, wordCount } from "../src/readings/index.js";
import sweep from "./fixtures/upstream-1106.json";
import sweepReads from "./fixtures/upstream-1106-reads.json";

const context = createContext({
  fleet: fleetOf(
    builtInFleet(fileURLToPath(new URL("./fixtures/upstream-services.json", import.meta.url))),
  ),
});
const now = new Date(sweep.sweep.at);
const facts = (): Facts => factsSchema.parse({ ...emptyFacts(), ...structuredClone(sweep) });

function fixture(edit?: (facts: Facts) => void) {
  const f = facts();
  edit?.(f);
  const model = buildModel(f, now, {}, context);
  const briefing = buildBriefing(model, { state: "clear", problems: [] }, now, context);
  const items = [...briefing.focus, ...briefing.rest];
  return { model, items, reads: {}, runs: f.runs.data };
}

describe("Engineering system reading", () => {
  it("counts verified forks on the recorded target, never open or merged PRs", () => {
    const input = fixture();
    const reading = engineeringReading(input);
    expect(reading.tiles[0]).toEqual({
      label: "Engineering system",
      value: "0 of 13",
      counts: "forks on 7d269b5",
    });
    expect(`${reading.tiles[0].value} ${reading.tiles[0].counts}`).toBe("0 of 13 forks on 7d269b5");
    expect(reading.verifiedTemplate).toEqual({
      verified: 0,
      total: 13,
      unread: 0,
      target: input.model.rollout?.target.sha ?? input.model.template.head?.sha,
    });
    expect(reading.tiles[1]).toEqual({
      label: "Template PRs",
      value: "13",
      counts: "open across the forks",
    });
    expect(reading.tiles[2]).toMatchObject({ label: "Rollout", value: "In progress" });
    expect(reading.folded).toContain("PR #263 chore: release 1.5.0");
    expect(wordCount(reading.headline)).toBeLessThanOrEqual(12);
    expect(readingText(reading).flatMap(internalNames)).toEqual([]);
    const fewerPrs = fixture((f) => {
      const repo = f.github.data?.repos["Azure/osdu-spi-partition"];
      if (!repo) throw new Error("Missing partition");
      repo.prs = repo.prs.filter((pr) => !pr.head.startsWith("template-sync/"));
    });
    expect(engineeringReading(fewerPrs).tiles[0]).toEqual(reading.tiles[0]);
    expect(engineeringReading(fewerPrs).verifiedTemplate).toEqual(reading.verifiedTemplate);
    expect(engineeringReading(fewerPrs).tiles[1].value).toBe("12");
  });

  it("does not verify a merged fork until its main run succeeds on the target", () => {
    const merged = (status: "in_progress" | "completed", conclusion?: string, later = false) =>
      fixture((f) => {
        const repo = f.github.data?.repos["Azure/osdu-spi-partition"];
        const template = f.template.data;
        const target = f.github.data?.repos[TEMPLATE_REPO]?.head;
        const runs = f.runs.data?.["Azure/osdu-spi-partition"];
        const previous = repo?.marker && template?.compares[repo.marker];
        const run = runs?.main[0];
        if (!repo || !template || !target || !runs || !previous || !run)
          throw new Error("Missing merge fixture");
        template.compares[target.sha] = {
          ...previous,
          marker: target.sha,
          aheadBy: 0,
          shas: [],
          changes: [],
        };
        repo.marker = target.sha;
        repo.prs = repo.prs.filter((pr) => !pr.head.startsWith("template-sync/"));
        repo.pastPrs = [
          {
            number: 999,
            title: "Template sync",
            url: `${repo.repo}/pull/999`,
            head: "template-sync/main",
            base: "main",
            createdAt: "2026-11-06T12:00:00Z",
            mergedAt: "2026-11-06T12:01:00Z",
          },
        ];
        runs.main = [{ ...run, status, conclusion, createdAt: "2026-11-06T12:02:00Z" }];
        if (later)
          runs.main.unshift({
            ...run,
            id: run.id + 1,
            status: "completed",
            conclusion: "success",
            createdAt: "2026-11-06T13:30:00Z",
          });
      });
    const pending = merged("in_progress");
    expect(pending.model.rollout?.merged).toBe(1);
    expect(engineeringReading(pending).tiles[0].value).toBe("0 of 13");
    expect(engineeringReading(pending).verifiedTemplate?.verified).toBe(0);
    expect(engineeringReading(merged("completed", "failure")).tiles[0].value).toBe("0 of 13");
    expect(engineeringReading(merged("completed", "failure")).verifiedTemplate?.verified).toBe(0);
    expect(engineeringReading(merged("completed", "success")).tiles[0].value).toBe("1 of 13");
    expect(engineeringReading(merged("completed", "success")).verifiedTemplate).toMatchObject({
      verified: 1,
      total: 13,
      unread: 0,
    });
    const later = merged("completed", "success", true);
    expect(
      later.model.rollout?.forks.find((fork) => fork.service === "partition")?.mainRun,
    ).toBeUndefined();
    expect(engineeringReading(later).tiles[0].value).toBe("1 of 13");
    expect(engineeringReading(later).verifiedTemplate?.verified).toBe(1);
    const runs = later.runs?.["Azure/osdu-spi-partition"];
    if (!runs) throw new Error("Missing partition runs");
    runs.main = runs.main.map((run) => ({ ...run, createdAt: "2026-11-06T12:00:00Z" }));
    expect(engineeringReading(later).tiles[0].value).toBe("0 of 13");
    expect(engineeringReading(later).verifiedTemplate?.verified).toBe(0);
  });

  it("does not turn unread template positions or PR lists into zero", () => {
    const model = buildModel(emptyFacts(), now, {}, context);
    const reading = engineeringReading({ model, items: [], reads: {} });
    expect(reading.headline).toBe("Engineering system not read yet.");
    expect(reading.tiles.map((tile) => tile.value)).toEqual([NOT_READ, NOT_READ, NOT_READ]);
    expect(readingText(reading).join(" ")).not.toMatch(/\b0\b/);
    expect(reading).not.toHaveProperty("verifiedTemplate");
    const partial = fixture((f) => {
      const repo = f.github.data?.repos["Azure/osdu-spi-partition"];
      if (!repo) throw new Error("Missing partition");
      repo.marker = undefined;
    });
    expect(engineeringReading(partial).tiles[0].counts).toBe("forks on 7d269b5 · 1 not read yet");
    expect(engineeringReading(partial).verifiedTemplate).toMatchObject({
      verified: 0,
      total: 13,
      unread: 1,
    });
    const unread = fixture((f) => {
      if (!f.github.data) throw new Error("Missing repositories");
      for (const fork of context.fleet.forks) {
        const repo = f.github.data.repos[fork.repo];
        if (repo) repo.marker = undefined;
      }
    });
    expect(engineeringReading(unread).tiles[0].value).toBe(NOT_READ);
    expect(engineeringReading(unread)).not.toHaveProperty("verifiedTemplate");
    const absentTarget = fixture();
    delete absentTarget.model.rollout;
    delete absentTarget.model.template.head;
    expect(engineeringReading(absentTarget)).not.toHaveProperty("verifiedTemplate");
  });

  it("keeps checking adoption after the active rollout has left the model", () => {
    const input = fixture();
    const { rollout: _rollout, ...model } = input.model;
    const line = model.lines[0];
    if (!line?.mainRun) throw new Error("Missing main run");
    const mainRun = line.mainRun;
    const mergedAt = "2026-11-06T12:01:00Z";
    const merged = {
      number: 999,
      title: "Template sync",
      url: "https://example.test/999",
      head: "template-sync/main",
      base: "main",
      createdAt: "2026-11-06T12:00:00Z",
      mergedAt,
    };
    const read = (createdAt: string, past = [merged]) =>
      engineeringReading({
        ...input,
        model: {
          ...model,
          lines: [
            {
              ...line,
              template: { ...line.template, behind: 0 },
              past,
              mainRun: { ...mainRun, status: "completed", conclusion: "success", createdAt },
            },
            ...model.lines.slice(1),
          ],
        },
      });
    expect(read("2026-11-06T12:02:00Z").tiles[0].value).toBe("1 of 13");
    expect(read("2026-11-06T12:02:00Z").verifiedTemplate?.verified).toBe(1);
    expect(read("2026-11-06T12:00:00Z").tiles[0].value).toBe("0 of 13");
    expect(read("2026-11-06T12:02:00Z", []).tiles[0].value).toBe("0 of 13");
  });

  it("uses only failed or cut contributing reads for the qualifier", () => {
    const input = fixture();
    const record: ReadRecord = {
      source: TEMPLATE_REPO,
      object: "compare",
      observedAt: now.toISOString(),
      completeness: { kind: "complete" },
    };
    expect(engineeringReading({ ...input, reads: { template: [record] } })).not.toHaveProperty(
      "qualifier",
    );
    expect(
      engineeringReading({
        ...input,
        reads: {
          template: [
            { ...record, completeness: { kind: "cut", read: 1, total: 2, reason: "limit" } },
          ],
        },
      }).qualifier,
    ).toBe(
      "GitHub template reads were incomplete, so adoption or template changes could be missing.",
    );
    expect(
      engineeringReading({ ...input, reads: { template: [{ ...record, failure: "unavailable" }] } })
        .qualifier,
    ).toBe("GitHub template reads failed, so adoption or template changes could be missing.");
    expect(
      engineeringReading({
        ...input,
        reads: {
          runs: [
            {
              ...record,
              source: "Azure/osdu-spi-partition",
              object: "actions/runs",
              failure: "unavailable",
            },
          ],
        },
      }).qualifier,
    ).toBe("GitHub Actions reads failed, so adoption or template changes could be missing.");
    expect(
      engineeringReading({
        ...input,
        reads: { github: [{ ...record, source: "Azure/osdu-spi-stack", failure: "unavailable" }] },
      }),
    ).not.toHaveProperty("qualifier");
  });

  it("does not qualify the recorded sweep on the radar's failed toolchain reads", () => {
    expect(sweepReads.radar.filter((read) => "failure" in read)).toHaveLength(3);
    expect(
      engineeringReading({
        ...fixture(),
        reads: { ...sweepReads, template: [] },
      }),
    ).not.toHaveProperty("qualifier");
  });

  it("shows a fleet rollout once, alongside the template repository's own items", () => {
    const input = fixture((f) => {
      const repo = f.github.data?.repos[TEMPLATE_REPO];
      const pr = repo?.prs[0];
      if (!repo || !pr) throw new Error("Missing template PR");
      repo.prs.push({
        ...pr,
        number: 999,
        head: "fix/template",
        title: "fix: repair template \u{1f527}",
        labels: [],
        checks: [
          { id: 1, name: "Repair", workflow: "CI", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      });
    });
    const rollout = input.items.find((item) => item.id === "rollout");
    if (!rollout) throw new Error("Missing rollout");
    const reading = engineeringReading({
      ...input,
      items: [...input.items, { ...rollout, id: "template-set" }],
    });
    expect(reading.items.filter((item) => item.id === "rollout")).toHaveLength(1);
    expect(reading.items.map((item) => item.id)).toContain("template-pr:999");
    expect(readingText(reading).join(" ")).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(reading.items.map((item) => item.id)).not.toContain("template-set");
    expect(reading.items.some((item) => context.fleet.forks.some((f) => f.id === item.scope))).toBe(
      false,
    );
  });

  it("groups projected due times, ownership and attention, capping and folding the rest", () => {
    const input = fixture();
    const base = input.items.find((item) => item.id === "rollout");
    if (!base) throw new Error("Missing rollout");
    const item = (n: number, extra: Partial<EngineeringItem>): EngineeringItem => ({
      ...base,
      id: `template-pr:${n}`,
      ids: [`template-pr:${n}`],
      scope: "osdu-spi",
      title: `Repair template ${n}`,
      ...extra,
    });
    const items = [
      item(1, { attention: "ambient" }),
      item(2, { attention: "surface" }),
      item(3, { owned: true }),
      item(4, { due: { at: "2026-11-07T00:00:00Z", before: "next sync" } }),
      item(5, { attention: "interrupt" }),
      item(6, { due: { at: "2026-11-06T23:00:00Z", before: "next sync" } }),
      item(7, { attention: "ambient" }),
    ];
    const reading = engineeringReading({ ...input, items });
    expect(reading.items.map((item) => item.id)).toEqual([
      "template-pr:6",
      "template-pr:4",
      "template-pr:3",
      "template-pr:5",
      "template-pr:2",
    ]);
    expect(reading.items.map((item) => item.group)).toEqual([
      expect.stringMatching(/^Before /),
      expect.stringMatching(/^Before /),
      "Owned",
      "Needs a decision",
      "New",
    ]);
    expect(reading.folded).toMatch(/2 more items/);
    expect(reading.folded).toContain("repair template 1");
    expect(reading.folded).toContain("repair template 7");
  });
});
