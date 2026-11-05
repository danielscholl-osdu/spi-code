// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BriefingSchema } from "./briefing.js";

const oracle: unknown = JSON.parse(
  readFileSync(
    new URL("../../../../fixtures/rib-59d6895/oracle/briefing.json", import.meta.url),
    "utf8",
  ),
);
const briefing = BriefingSchema.parse(oracle);
const focus = briefing.focus[0];
const lane = briefing.environment.lanes[0];
if (!focus || !lane) throw new Error("The Briefing oracle must include focus and lanes");

describe("Briefing contract", () => {
  it("round-trips the frozen rib Briefing without dropping fields", () => {
    expect(briefing).toEqual(oracle);
  });
  it.each([
    { ...focus, rung: 3 },
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
    { ...briefing, facts: [{ ...briefing.facts[0], extra: true }] },
    { ...briefing, horizon: { headline: "", extra: true } },
    { ...briefing, ready: [{ id: "", text: "", count: -1 }] },
    {
      ...briefing,
      themes: [{ ...briefing.themes[0], certain: [{ fork: "", state: "", extra: true }] }],
    },
  ])("rejects unknown keys and invalid values in nested sections", (invalid) => {
    expect(BriefingSchema.safeParse(invalid).success).toBe(false);
  });
});
