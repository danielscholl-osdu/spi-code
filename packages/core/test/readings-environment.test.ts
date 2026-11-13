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
  it("names v0.35.3 ready with its green time in a headline of at most 12 words", () => {
    const reading = environment();
    expect(reading.headline).toBe("v0.35.3 is ready, green since 11-05 22:20.");
    expect(wordCount(reading.headline)).toBeLessThanOrEqual(12);
    expect(reading.tiles[0]).toEqual({
      label: "Version",
      value: "v0.35.3",
      counts: "running · the latest release · landed 3\u00a0h 32\u00a0min after its release",
    });
  });

  it("reads the forks' newest deploys and the stack repository's open work", () => {
    const reading = environment();
    expect(reading.tiles[1]).toEqual({
      label: "Fork deploys",
      value: "All passed",
      counts: "each fork's newest deploy to the environment",
    });
    for (const text of [
      reading.headline,
      ...reading.tiles.flatMap((t) => [t.label, t.value, t.counts]),
    ])
      expect(text).not.toMatch(/deployable|Lane|Stopped/);
    expect(reading.tiles[2]).toEqual({
      label: "Stack repository",
      value: "2",
      counts: "open · 2 issues (1 bug) · 0 pull requests",
    });
    expect(reading.folded).toBe(
      "Open in osdu-spi-stack: [bug] spi build fails on Dockerfiles with FROM --platform: ACR dependency scan rejects it #463, and 1 more.",
    );
  });

  it("counts the forks whose newest deploy failed and names them", () => {
    const forks = model.stack.forks;
    if (!forks) throw new Error("no fork deploys read");
    const failing = new Set(["legal", "partition"]);
    const failed = {
      ...model,
      stack: {
        ...model.stack,
        forks: {
          ...forks,
          newest: forks.newest.map((f) => (failing.has(f.fork) ? { ...f, passed: false } : f)),
        },
      },
    };
    expect(environment({ model: failed }).tiles[1]).toEqual({
      label: "Fork deploys",
      value: "2 failed",
      counts: "each fork's newest deploy to the environment · failed: partition and legal",
    });
    const none = { ...model, stack: { ...model.stack, forks: { ...forks, newest: [] } } };
    expect(environment({ model: none }).tiles[1]?.value).toBe("None yet");
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
      ["stack:extra-3", "Waiting on you"],
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
    ).toBe(
      "GitHub truncated a read of the environment, so this reading could be missing something.",
    );
    expect(
      environment({
        reads: [read(stackRepo, { failure: "HTTP 502" })],
        lifecycle: [
          read(`repos/${stackRepo}/actions/runs`, {
            completeness: { kind: "cut", reason: "page limit", read: 100, total: 240 },
          }),
        ],
      }).qualifier,
    ).toBe(
      "GitHub truncated a read of the environment and a read failed, so this reading could be missing something.",
    );
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
    const since = now.getTime() - (2 * 24 + 13) * 3_600_000;
    const timed = {
      ...held,
      stack: {
        ...held.stack,
        availability: { share: 0.9, long: 1, longMs: 0, heldNow: true, since },
      },
    };
    const hours = {
      ...timed,
      stack: {
        ...timed.stack,
        availability: { ...timed.stack.availability, since: now.getTime() - 5 * 3_600_000 },
      },
    };
    const running = environment({ model: inflight }).headline;
    const unknownStart = environment({ model: held }).headline;
    const known = environment({ model: hours }).headline;
    const long = environment({ model: timed }).headline;
    expect(running).toBe("v0.35.3 is in maintenance while an upgrade to v0.36.0 runs.");
    expect(unknownStart).toBe("v0.35.3 is in maintenance with no run in flight.");
    expect(known).toBe("v0.35.3 in maintenance for 5\u00a0h, with no run in flight.");
    expect(long).toBe("v0.35.3 in maintenance for 2\u00a0d 13\u00a0h, no run in flight.");
    for (const headline of [running, unknownStart, known, long])
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
