// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildBriefing, type FocusItem } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { ReadRecord } from "../src/evidence/index.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { buildModel, type Model } from "../src/model/index.js";
import { environmentReading } from "../src/readings/environment.js";
import { internalNames, NOT_READ, readingText, wordCount } from "../src/readings/index.js";
import sweep from "./fixtures/upstream-1106.json";

const previous = process.env.TZ;
process.env.TZ = "America/Chicago";
afterAll(() => {
  if (previous === undefined) delete process.env.TZ;
  else process.env.TZ = previous;
});

const context = createContext({
  fleet: fleetOf(
    builtInFleet(fileURLToPath(new URL("./fixtures/upstream-services.json", import.meta.url))),
  ),
});
const facts: Facts = { ...emptyFacts(), ...(structuredClone(sweep) as unknown as Partial<Facts>) };
const now = new Date(facts.sweep?.at ?? "");
const model = buildModel(facts, now, {}, context);
const briefing = buildBriefing(model, { state: "clear", problems: [] }, now, context);
const items: FocusItem[] = [...briefing.focus, ...briefing.rest];
const stackRepo = context.stackRepo;

const environment = (
  over: {
    model?: Model;
    items?: readonly FocusItem[];
    reads?: readonly ReadRecord[];
    lifecycle?: readonly ReadRecord[];
  } = {},
) =>
  environmentReading({
    model: over.model ?? model,
    items: over.items ?? items,
    facts,
    lifecycle: over.lifecycle ?? [],
    reads: over.reads ?? [],
    stackRepo,
    now,
  });

const read = (object: string, extra: Partial<ReadRecord> = {}): ReadRecord => ({
  source: "github",
  object,
  observedAt: now.toISOString(),
  completeness: { kind: "complete" },
  ...extra,
});

const envItem = (n: number, rung: FocusItem["rung"]): FocusItem => ({
  ...(items[0] as FocusItem),
  id: `stack:extra-${n}`,
  ids: [`stack:extra-${n}`],
  rung,
  scope: "Environment",
  title: `Environment item ${n}`,
});

describe("Environment reading on the recorded 6 Nov sweep", () => {
  it("names v0.35.3 deployable with its green time in a headline of at most 12 words", () => {
    const reading = environment();
    expect(reading.headline).toBe("v0.35.3 is deployable, green since 11-05 22:20.");
    expect(wordCount(reading.headline)).toBeLessThanOrEqual(12);
    expect(reading.tiles[0]).toEqual({
      label: "Version",
      value: "v0.35.3",
      counts: "running · the latest release · landed 3 h 32 min after its release",
    });
  });

  it("reads the fork lanes' worst state and the stack repository's open work", () => {
    const reading = environment();
    expect(reading.tiles[1]).toEqual({
      label: "Lane",
      value: "Clear",
      counts: "fork lanes · newest deploy passed on 13 of 13",
    });
    expect(reading.tiles[2]).toEqual({
      label: "Stack repository",
      value: "2",
      counts: "open · 2 issues (1 bug) · 0 pull requests",
    });
    expect(reading.folded).toBe(
      "Open in osdu-spi-stack: [bug] spi build fails on Dockerfiles with FROM --platform: ACR dependency scan rejects it #463, and 1 more.",
    );
  });

  it("names the forks whose lane is in the worst state", () => {
    const stopLane = (line: Model["lines"][number]) => ({
      ...line,
      stations: line.stations.map((s) =>
        s.id === "lane" ? { ...s, state: "stopped" as const } : s,
      ),
    });
    const [first, ...others] = model.lines;
    if (!first) throw new Error("no lines");
    const stopped = { ...model, lines: [stopLane(first), ...others] };
    expect(environment({ model: stopped }).tiles[1]).toEqual({
      label: "Lane",
      value: "Stopped",
      counts: `fork lanes · ${first.fork.id} · newest deploy passed on 13 of 13`,
    });
  });

  it("counts and folds a pipeline pull request on the stack repository", () => {
    const repos = facts.github.data?.repos ?? {};
    const pr = Object.values(repos).flatMap((r) => r.prs)[0];
    const repo = repos[stackRepo];
    if (!pr || !repo) throw new Error("no recorded pull request or stack repository");
    const release = {
      ...pr,
      number: 999,
      title: "chore: release 0.36.0",
      head: "release-please--branches--main",
    };
    const github = facts.github.data;
    if (!github) throw new Error("no github read");
    const withRelease: Facts = {
      ...facts,
      github: {
        ...facts.github,
        data: {
          ...github,
          repos: {
            ...repos,
            [stackRepo]: { ...repo, prs: [release], issues: [], openPrs: 1, openIssues: 0 },
          },
        },
      },
    };
    const reading = environmentReading({
      model: buildModel(withRelease, now, {}, context),
      items: [],
      facts: withRelease,
      lifecycle: [],
      reads: [],
      stackRepo,
      now,
    });
    expect(reading.tiles[2]).toEqual({
      label: "Stack repository",
      value: "1",
      counts: "open · 0 issues · 1 pull request",
    });
    expect(reading.folded).toBe("Open in osdu-spi-stack: chore: release 0.36.0 #999.");
  });

  it("stays within five items and shows no internal names", () => {
    const reading = environment();
    expect(reading.items.length).toBeLessThanOrEqual(5);
    expect(readingText(reading).flatMap(internalNames)).toEqual([]);
    expect(reading).not.toHaveProperty("qualifier");
  });

  it("caps environment items at five, grouped by when they bite, and folds the rest", () => {
    const extra = [
      envItem(1, 2),
      envItem(2, 0),
      envItem(3, 1),
      envItem(4, 2),
      envItem(5, 2),
      envItem(6, 2),
      envItem(7, 2),
    ];
    const service = { ...envItem(8, 0), id: "other", ids: ["other"], scope: "entitlements" };
    const reading = environment({ items: [...items, service, ...extra] });
    expect(reading.items.map((i) => [i.id, i.group])).toEqual([
      ["stack:extra-2", "Stopped"],
      ["stack:extra-3", "Needs a decision"],
      ["stack:extra-1", "Ready to move"],
      ["stack:extra-4", "Ready to move"],
      ["stack:extra-5", "Ready to move"],
    ]);
    expect(reading.folded).toMatch(/^2 more items: Environment environment item 6, /);
  });

  it("qualifies itself only on failed or cut reads of the environment", () => {
    expect(
      environment({ reads: [read("Azure/osdu-spi-partition", { failure: "boom" })] }),
    ).not.toHaveProperty("qualifier");
    expect(environment({ reads: [read(stackRepo, { failure: "boom" })] }).qualifier).toBe(
      "A read failed for the environment, so this reading could be missing something.",
    );
    expect(
      environment({
        lifecycle: [
          read(`repos/${stackRepo}/actions/runs`, {
            completeness: { kind: "cut", reason: "page limit", read: 100, total: 240 },
          }),
        ],
      }).qualifier,
    ).toBe("GitHub cut a read of the environment, so this reading could be missing something.");
  });

  it("keeps a held or running environment's headline within 12 words", () => {
    const run = model.stack.lastGreen;
    if (!run) throw new Error("no green run");
    const inflight = {
      ...model,
      stack: {
        ...model.stack,
        deployable: { state: "no" as const, reason: "env-upgrade in flight" },
        inflight: { run: { ...run, kind: "upgrade" as const, target: "v0.36.0" }, stages: [] },
      },
    };
    const held = {
      ...model,
      stack: {
        ...model.stack,
        deployable: { state: "no" as const, reason: "The environment is in maintenance." },
      },
    };
    const running = environment({ model: inflight }).headline;
    expect(running).toBe("v0.35.3 is not deployable while an upgrade to v0.36.0 runs.");
    expect(environment({ model: held }).headline).toBe(
      "v0.35.3 is held in maintenance with no run in flight.",
    );
    for (const headline of [running, environment({ model: held }).headline])
      expect(wordCount(headline)).toBeLessThanOrEqual(12);
  });
});

describe("Environment reading before anything was read", () => {
  const empty = emptyFacts();
  const unread = environmentReading({
    model: buildModel(empty, now, {}, context),
    items: [],
    facts: empty,
    lifecycle: [],
    reads: [],
    stackRepo,
    now,
  });

  it("reads the version, lanes and stack repository as not read yet, never as zero", () => {
    expect(unread.headline).toBe(`The environment is ${NOT_READ}.`);
    expect(unread.tiles.map((t) => t.value)).toEqual([NOT_READ, NOT_READ, NOT_READ]);
    expect(readingText(unread).join(" ")).not.toMatch(/\b0\b/);
    expect(unread.folded).toBeNull();
  });
});
