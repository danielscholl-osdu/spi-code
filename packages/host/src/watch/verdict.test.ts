// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { projectWatch, type WatchInput } from "./project.js";
import { badInput, busyInput, calmInput, recordedInput } from "./snapshot-fixture.js";

process.env.TZ = "UTC";

const verdictOf = (input: WatchInput) => projectWatch(input).briefing.verdict;

describe("Today's verdict (decision.md: Headline, Calm and bad mornings)", () => {
  it("calm: says nothing urgent, names the deployable version and every fork flowing, with ○", () => {
    const view = projectWatch(calmInput());
    const version = view.briefing.facts.find(({ label }) => label === "Environment")?.figure;
    expect(version).toMatch(/^v\d/);
    expect(view.briefing.verdict).toEqual({
      text: `Nothing urgent needs you. ${version} is deployable; all 13 forks are flowing.`,
      mark: "nothing-due",
    });
  });

  it("busy: an in-system Interrupt and upstream Surface cards name both origins", () => {
    const view = projectWatch(busyInput());
    const items = [...view.briefing.focus, ...view.briefing.rest];
    expect(
      items.filter((item) => item.attention === "interrupt").map((item) => item.origin),
    ).toEqual(["system"]);
    const heading = view.briefing.horizon.counts?.text ?? "";
    expect(heading).toMatch(/^4 need you before they land/);
    expect(view.briefing.verdict).toEqual({
      text: "1 thing needs you; 2 forks are stopped; 4 upstream changes need you before they land.",
      mark: "stopped",
    });
    const count = (text: string) =>
      /(\d+) (?:upstream changes? )?needs? you before/.exec(text)?.[1];
    expect(count(view.briefing.verdict?.text ?? "")).toBe(count(heading));
  });

  it("bad: counts every Interrupt once, names the strip's stopped forks and the unread area", () => {
    expect(verdictOf(badInput())).toEqual({
      text: "3 things need you; 4 forks are stopped. GitHub wasn't read this sweep.",
      mark: "stopped",
    });
  });

  it("a recorded morning with unread areas never takes the calm mark", () => {
    expect(verdictOf(recordedInput())).toEqual({
      text: "1 thing needs you; 1 fork is stopped; 6 upstream changes need you before they land. Run approvals, the upstream radar and security alerts weren't read this sweep.",
      mark: "stopped",
    });
  });

  it("calm with one area unread withholds ○ and the calm sentence", () => {
    const input = calmInput();
    const verdict = verdictOf({ ...input, reads: { ...input.reads, security: [] } });
    expect(verdict).toEqual({
      text: "Nothing read needs you. Security alerts weren't read this sweep.",
      mark: "in-progress",
    });
  });

  it("calm with the fleet read failed withholds ○ and the calm sentence", () => {
    const input = calmInput();
    const failed = (input.reads.fleet ?? []).map((record) => ({ ...record, failure: "offline" }));
    expect(failed.length).toBeGreaterThan(0);
    const view = projectWatch({ ...input, reads: { ...input.reads, fleet: failed } });
    expect(view.areas.find(({ area }) => area === "fleet")?.envelope.state).toBe("failed");
    expect(view.briefing.verdict).toEqual({
      text: "Nothing read needs you. Fleet membership wasn't read this sweep.",
      mark: "in-progress",
    });
    const binding = view.provenance.find(({ path }) => path === "/briefing/verdict");
    expect(binding?.areas).toContain("fleet");
  });

  it("calm with deployability unproven never claims deployable", () => {
    const input = calmInput();
    const verdict = verdictOf({
      ...input,
      facts: {
        ...input.facts,
        lifecycle: {
          ...input.facts.lifecycle,
          data: { refresh: [], smoke: [], sweeper: [], upgrade: [] },
        },
      },
    });
    expect(verdict).toEqual({
      text: "Nothing urgent needs you. The environment isn't shown deployable.",
      mark: "in-progress",
    });
  });
});
