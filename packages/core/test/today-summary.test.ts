// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { todayLines } from "../src/brief/lines";
import { releasesToday } from "../src/brief/releases-today";
import { sinceOf } from "../src/brief/since";
import { todayHistory, todaySummary } from "../src/brief/today-summary";
import {
  sweep1116Context as context,
  SWEEP_1116_NOW as now,
  sweep1116Facts,
  sweep1116Items,
  sweep1116Model,
} from "./sweep-1116";

const facts = sweep1116Facts();
const model = sweep1116Model(facts);
const items = sweep1116Items(model);
const lines = todayLines(model, items, now, context);
const since = sinceOf(model, facts, now, 300_000);
const summary = () => todaySummary({ model, facts, items, lines, since, now, context });

describe("Today's lower sections on the unchanged 16 Nov sweep", () => {
  test("one pile per place with the release, repository and security counts", () => {
    const piles = summary().canWait;
    const release = releasesToday({ services: [], documents: [], facts, provenance: [], context });
    expect(release.readyLine).toContain("osdu-spi-stack #474 ready to merge");
    expect(release.ready).toEqual([
      {
        name: "osdu-spi-stack",
        number: 474,
        url: "https://github.com/Azure/osdu-spi-stack/pull/474",
      },
    ]);
    expect(piles.map((p) => [p.label, p.place])).toEqual([
      ["Release PRs", "releases"],
      ["Repositories", "engineering"],
      ["Security", "security"],
    ]);
    expect(piles.map((p) => p.counts.map((c) => [c.kind, c.count]))).toEqual([
      [
        ["open", 14],
        ["ready", 1],
        ["review", 13],
        ["failed", 0],
      ],
      [
        ["issues", 13],
        ["changes", 7],
        ["dependabot", 27],
      ],
      [
        ["vulnerabilities", 6],
        ["code-scanning", 22],
      ],
    ]);
    expect(piles[0]?.counts.find((c) => c.kind === "ready")?.names).toEqual([
      "osdu-spi-stack #474",
    ]);
  });

  test("no member or source of a Today line is in Can wait; exclusion uses the supplied lines", () => {
    const urls = new Set(
      lines.flatMap((l) =>
        l.members.flatMap((m) => [
          m.subject,
          m.primary?.url,
          ...items.filter((i) => m.ids.includes(i.id)).flatMap((i) => i.evidence.map((e) => e.url)),
        ]),
      ),
    );
    expect(
      summary()
        .canWait.flatMap((p) => p.counts.flatMap((c) => c.urls))
        .some((u) => urls.has(u)),
    ).toBe(false);
    const withoutLines = todaySummary({ model, facts, items, lines: [], since, now, context });
    expect(withoutLines.canWait[1]?.counts.find((c) => c.kind === "issues")?.count).toBe(15);
  });

  test("at most three moving or scheduled rows, with lanes counted from stations", () => {
    const moving = summary().moving;
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.length).toBeLessThanOrEqual(3);
    expect(moving.find((r) => r.id === "lanes")?.names).toEqual(["partition"]);
    expect(moving.every((r) => r.time && r.place)).toBe(true);
    const crowded = structuredClone(model);
    crowded.stack.inflight = { run: { kind: "upgrade" } } as typeof crowded.stack.inflight;
    expect(
      todaySummary({ model: crowded, facts, items, lines, since, now, context }).moving,
    ).toHaveLength(3);
  });

  test("one history row per workflow with failed and not-read outcomes counted apart", () => {
    const history = summary().history;
    expect(history.basis).toBe("fallback");
    expect(history.rows.map((r) => r.workflow)).toEqual(["sync", "template"]);
    expect(history.rows[0]?.counts.find((c) => c.kind === "failed")?.names).toEqual([
      "indexer",
      "search",
      "crs-conversion",
    ]);
    expect(history.rows[0]?.counts.find((c) => c.kind === "not-read")?.count).toBeGreaterThan(0);
    for (const row of history.rows)
      expect(row.counts.reduce((n, c) => n + c.count, 0)).toBe(model.lines.length);
  });

  test("a workflow whose runs were not read never claims zero failures", () => {
    const unread = sweep1116Facts();
    unread.runs = {};
    const unreadModel = sweep1116Model(unread);
    const history = todayHistory(unreadModel, unread, undefined, now);
    for (const row of history.rows) {
      expect(row.counts).toEqual([expect.objectContaining({ kind: "not-read", count: 13 })]);
      expect(row.notRead).toHaveLength(13);
    }
  });

  test("seen history keeps its window and names outcomes that were not read", () => {
    const seen = sinceOf(model, facts, now, 300_000, "2026-11-16T20:00:00Z");
    const history = todayHistory(model, facts, seen, now);
    expect(history.basis).toBe("seen");
    expect(history.from).toBe("2026-11-16T20:00:00.000Z");
    expect(history.rows[0]?.counts.some((c) => c.kind === "not-read")).toBe(true);
  });
});
