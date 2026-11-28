// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BriefingSchema,
  fleetLines,
  type TodayLine,
  type TodayMember,
  TodaySummarySchema,
  todayCounts,
} from "./briefing.js";

const frozen = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/rib-59d6895/oracle/briefing.json", import.meta.url),
    "utf8",
  ),
);
// SPI retired the rib's Today tiles, n-more count and ready lines; the rib's upgrade is in flight.
const { facts: _facts, more: _more, ready: _ready, ...current } = frozen;
const oracle = { ...current, environment: { ...current.environment, deployable: "no" } };
const briefing = BriefingSchema.parse(oracle);
const focus = briefing.focus[0];
const lane = briefing.environment.lanes[0];
if (!focus || !lane) throw new Error("The Briefing oracle must include focus and lanes");

describe("Briefing contract", () => {
  it("round-trips the frozen rib Briefing without dropping fields", () => {
    expect(briefing).toEqual(oracle);
  });
  it.each(["facts", "more", "ready"])("rejects the retired %s field", (key) => {
    expect(BriefingSchema.safeParse({ ...briefing, [key]: frozen[key] }).success).toBe(false);
  });
  it("rejects an environment without its deployable state", () => {
    const { deployable: _deployable, ...environment } = briefing.environment;
    expect(BriefingSchema.safeParse({ ...briefing, environment }).success).toBe(false);
  });
  it("keeps an additive origin on base briefing items", () => {
    const withOrigin = { ...briefing, focus: [{ ...focus, origin: "upstream" }] };
    expect(BriefingSchema.parse(withOrigin)).toEqual(withOrigin);
  });
  it("keeps an additive age and blocks chip on base briefing items", () => {
    const withChips = {
      ...briefing,
      focus: [{ ...focus, age: "2h", blocks: { count: 3, text: "blocks 3" } }],
    };
    expect(BriefingSchema.parse(withChips)).toEqual(withChips);
  });
  it.each([
    { ...focus, blocks: { count: 0, text: "blocks 0" } },
    { ...focus, blocks: { count: 2 } },
    { ...focus, age: 2 },
    { ...focus, rung: 3 },
    { ...focus, origin: "gitlab" },
    { ...focus, cls: "OTHER" },
    { ...focus, cause: undefined },
    { ...focus, evidence: [{ label: "run", url: 42 }] },
    { ...focus, more: [{ label: "Plan", text: "Review", extra: true }] },
  ])("rejects a planted invalid focus item in focus and rest", (item) => {
    for (const key of ["focus", "rest"]) {
      expect(BriefingSchema.safeParse({ ...briefing, [key]: [item] }).success).toBe(false);
    }
  });
  it.each([
    { ...lane, id: "deploy" },
    { ...lane, extra: true },
    {
      ...lane,
      events: [{ id: "run", start: "yesterday", state: "running", label: "", detail: "" }],
    },
    {
      ...lane,
      events: [
        {
          id: "run",
          start: briefing.environment.from,
          state: "unknown",
          label: "",
          detail: "",
        },
      ],
    },
  ])("rejects a planted invalid environment lane", (invalid) => {
    expect(
      BriefingSchema.safeParse({
        ...briefing,
        environment: { ...briefing.environment, lanes: [invalid] },
      }).success,
    ).toBe(false);
  });
  it.each([
    { ...briefing, extra: true },
    { ...briefing, doctor: { ...briefing.doctor, extra: true } },
    { ...briefing, environment: { ...briefing.environment, deployable: "maybe" } },
    { ...briefing, horizon: { headline: "", extra: true } },
    {
      ...briefing,
      repositories: {
        ...briefing.repositories,
        template: { label: "", figure: "", sub: "", tone: "neutral", extra: true },
      },
    },
    {
      ...briefing,
      themes: [{ ...briefing.themes[0], certain: [{ fork: "", state: "", extra: true }] }],
    },
  ])("rejects unknown keys and invalid values in nested sections", (invalid) => {
    expect(BriefingSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("since observation time", () => {
  it("requires asOf for stale rows", () => {
    expect(
      BriefingSchema.safeParse({
        ...briefing,
        since: { basis: "stale", from: briefing.environment.from, rows: [] },
      }).success,
    ).toBe(false);
    expect(
      BriefingSchema.safeParse({
        ...briefing,
        since: {
          basis: "stale",
          from: briefing.environment.from,
          asOf: briefing.environment.to,
          rows: [],
        },
      }).success,
    ).toBe(true);
  });
  it.each(["seen", "fallback", "history-short"])("forbids asOf for %s rows", (basis) => {
    const since = { basis, from: briefing.environment.from, rows: [] };
    expect(BriefingSchema.safeParse({ ...briefing, since }).success).toBe(true);
    expect(
      BriefingSchema.safeParse({ ...briefing, since: { ...since, asOf: briefing.environment.to } })
        .success,
    ).toBe(false);
  });
});

describe("Today count", () => {
  const member = (id: string, fork: string, station?: TodayMember["station"]): TodayMember => ({
    id,
    ids: [id],
    fork,
    ...(station ? { station } : {}),
    cause: "",
    effect: "",
    steps: [],
    evidence: { areas: [], attributed: "item", notRead: [] },
  });
  const line = (
    id: string,
    subject: string,
    members: TodayMember[],
    section: TodayLine["section"] = "waiting",
  ): TodayLine => ({
    id,
    section,
    subject,
    headline: subject,
    cause: "",
    effect: "",
    steps: [],
    members,
  });

  it.each([
    [
      "n forks",
      line(
        "group",
        "3 forks",
        ["a", "b", "c"].map((id) => member(id, id)),
      ),
      3,
    ],
    [
      "review rollout",
      line(
        "review",
        "2 forks",
        ["one", "two"].map((id) => member(`rollout:${id}`, id)),
      ),
      2,
    ],
    [
      "dispatch rollout",
      line(
        "dispatch",
        "Template",
        ["rollout:a"].map((id) => member(id, id)),
      ),
      1,
    ],
    ["port", line("port", "Upstream", [member("port", "fleet")]), 1],
    ["single fork", line("single", "partition", [member("main", "partition")]), 1],
  ])("counts %s as %i", (_name, row, expected) => {
    expect(todayCounts({ lines: [row] })).toEqual({
      total: expected,
      blocked: 0,
      waiting: expected,
    });
  });

  it("deduplicates a member on two lines and splits the remaining total by section", () => {
    const a = member("a", "a");
    const b = member("b", "b");
    const result = todayCounts({
      lines: [line("blocked", "1 fork", [a], "blocked"), line("waiting", "2 forks", [a, b])],
    });
    expect(result).toEqual({ total: 2, blocked: 1, waiting: 1 });
    expect(todayCounts({ lines: [] })).toEqual({ total: 0, blocked: 0, waiting: 0 });
  });

  it("counts an operation once instead of also counting its member on another line", () => {
    const shared = member("shared", "shared");
    expect(
      todayCounts({
        lines: [
          line("fork", "1 fork", [shared], "blocked"),
          line("operation", "Template", [shared]),
        ],
      }),
    ).toEqual({ total: 1, blocked: 0, waiting: 1 });
  });

  it("counts grouped and operation rows whole and under each station filter", () => {
    const group = line("group", "2 forks", [
      member("sync", "sync", "sync"),
      member("integration", "integration", "integration"),
    ]);
    const operation = line("operation", "Template", [
      member("rollout:one", "one", "template"),
      member("rollout:two", "two", "sync"),
    ]);
    expect(todayCounts({ lines: [group, operation] }).total).toBe(3);
    expect(todayCounts({ lines: fleetLines([group, operation], "sync") }).total).toBe(2);
    expect(todayCounts({ lines: fleetLines([group, operation], "integration") }).total).toBe(1);
    expect(todayCounts({ lines: fleetLines([group, operation], "template") }).total).toBe(1);
  });

  it("caps scheduled moving rows without cutting proven in-flight rows", () => {
    const row = (index: number, at?: string) => ({
      id: `moving-${index}`,
      label: "Main run",
      place: "line" as const,
      time: at ? at : "Now",
      ...(at ? { at } : {}),
      count: 1,
      names: ["partition"],
    });
    const summary = {
      canWait: [],
      moving: [row(0), row(1), row(2), row(3), row(4)],
      history: {
        basis: "fallback",
        from: "2026-11-16T00:00:00.000Z",
        rows: [],
      },
    };
    expect(TodaySummarySchema.safeParse(summary).success).toBe(true);
    expect(
      TodaySummarySchema.safeParse({
        ...summary,
        moving: [0, 1, 2, 3].map((index) =>
          row(index, `2026-11-${String(17 + index).padStart(2, "0")}T00:00:00.000Z`),
        ),
      }).success,
    ).toBe(false);
  });
});
