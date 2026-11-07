// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildBriefing, type FocusItem } from "../src/brief/index.js";
import { builtInFleet, fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import type { ReadRecord } from "../src/evidence/index.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { buildModel } from "../src/model/index.js";
import { internalNames, NOT_READ, readingText, wordCount } from "../src/readings/index.js";
import { type ReleaseMonth, releasesReading } from "../src/readings/releases.js";
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

// The Releases pane's lines, newest first, as the release reads build them.
const months: ReleaseMonth[] = [
  {
    id: "release:2026-11",
    month: "2026-11",
    name: "2026.11",
    open: true,
    stateText: "In progress, closes Nov 30",
    notes: "draft",
  },
  {
    id: "release:2026-10",
    month: "2026-10",
    name: "2026.10",
    open: false,
    stateText: "Closed Oct 31",
    notes: "approved",
  },
  {
    id: "release:2026-09",
    month: "2026-09",
    name: "2026.09",
    open: false,
    stateText: "Closed Sep 30",
    notes: "none",
  },
];

const read = (over: Partial<ReadRecord> = {}): ReadRecord => ({
  source: "github-releases",
  object: "Azure/osdu-spi-file",
  observedAt: now.toISOString(),
  completeness: { kind: "complete" },
  ...over,
});

const releases = (over: { facts?: Facts; reads?: ReadRecord[]; months?: ReleaseMonth[] } = {}) =>
  releasesReading({
    facts: over.facts ?? facts,
    items,
    months: over.months ?? months,
    reads: over.reads ?? [read()],
    context,
  });

describe("Releases reading on the recorded 6 Nov sweep", () => {
  it("reads 13 release PRs open, 1 failing (#89)", () => {
    const reading = releases();
    expect(reading.headline).toBe("13 release PRs open, 1 failing (#89).");
    expect(wordCount(reading.headline)).toBeLessThanOrEqual(12);
    expect(reading.qualifier).toBeUndefined();
    expect(reading.tiles).toEqual([
      { label: "Release PRs open", value: "13", counts: "1 ready to merge, 12 wait for review" },
      { label: "Failing", value: "1", counts: "entitlements #89" },
      {
        label: "Current release",
        value: "2026.11",
        counts: "In progress, closes Nov 30 · notes in draft",
      },
    ]);
    expect(readingText(reading).flatMap(internalNames)).toEqual([]);
  });

  it("carries every Releases field of the briefing, in the reading or one level below", () => {
    const reading = releases();
    const text = readingText(reading).join("\n");
    const ready = briefing.ready.find((r) => r.id === "releases");
    expect(ready).toMatchObject({ text: "13 release PRs", count: 13 });
    expect(reading.headline.startsWith(`${ready?.count} release PRs`)).toBe(true);
    expect(reading.tiles[0].value).toBe(String(ready?.count));

    // Each waiting release PR the briefing counts is named with its tag, number and what it waits on.
    const queued = model.queue.items.find((i) => i.id === "releases");
    expect(queued?.cause).toHaveLength(13);
    for (const row of queued?.cause ?? []) {
      const [tag, number, state] = row.value.split(" · ");
      expect(reading.folded).toContain(`${row.label} ${tag} ${number}`);
      const head = state === "approved and green" ? "Ready to merge" : "Waiting for review";
      const section = (reading.folded ?? "")
        .split(/(?<=#\d+)\. /)
        .find((part) => part.startsWith(`${head}:`));
      expect(section).toContain(`${row.label} ${tag} ${number}`);
    }

    // The failing release PR passes through as the briefing item, its check title's emoji stripped.
    const red = items.filter((i) => i.id.startsWith("release-red:"));
    expect(red.map((i) => i.id)).toEqual(["release-red:Azure/osdu-spi-entitlements#89"]);
    expect(red[0]?.title).toMatch(/\p{Extended_Pictographic}/u);
    expect(reading.items).toEqual([
      {
        ...red[0],
        title: "Release PR #89 fails Code Coverage",
        group: "Needs a decision",
      },
    ]);
    expect(reading.tiles[1].value).toBe(String(red.length));

    // The current month's name, state and notes are on the reading; earlier months are named, and
    // each month's headline, stats and key changes are on its own release-month place.
    for (const field of ["2026.11", "In progress, closes Nov 30", "notes in draft"])
      expect(text).toContain(field);
    expect(reading.folded).toContain("Earlier months: 2026.10 and 2026.09, all closed.");
  });

  it("qualifies itself only when a release or GitHub read failed or was cut", () => {
    expect(
      releases({ reads: [read(), read({ object: "Azure/osdu-spi-legal", failure: "HTTP 502" })] })
        .qualifier,
    ).toBe("The reads failed for 1 repository, so a release PR or month could be missing.");
    expect(
      releases({
        reads: [
          read({
            source: "github",
            completeness: { kind: "cut", reason: "page limit", read: 100, total: 140 },
          }),
          read({ source: "github-created", object: "Azure/osdu-spi-legal", failure: "HTTP 502" }),
        ],
      }).qualifier,
    ).toBe(
      "GitHub truncated the reads for 1 repository and the reads failed for 1 repository, so a release PR or month could be missing.",
    );
  });

  it("reads not read yet, never a zero, before GitHub or the release months are read", () => {
    const reading = releases({ facts: { ...facts, github: {} }, months: [] });
    expect(reading.headline).toBe("Release PRs not read yet.");
    expect(reading.tiles.map((t) => t.value)).toEqual([NOT_READ, NOT_READ, NOT_READ]);
    expect(reading.items).toEqual([]);
    expect(reading.folded).toBeNull();
    expect(readingText(reading).join(" ")).not.toMatch(/\b0\b/);

    // Release PRs read, release months not: only the current-release tile is unread.
    const monthsUnread = releases({ months: [] });
    expect(monthsUnread.headline).toBe("13 release PRs open, 1 failing (#89).");
    expect(monthsUnread.tiles[2]).toEqual({
      label: "Current release",
      value: NOT_READ,
      counts: "the release months",
    });
    expect(monthsUnread.folded).not.toContain("Earlier months");
  });
});
