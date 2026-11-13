// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  appStyle,
  badInput,
  busyInput,
  calmInput,
  recordedInput,
} from "../../test/watch/snapshot-fixture.js";
import { projectWatch, type WatchInput } from "./project.js";

process.env.TZ = "UTC";

const verdictOf = (input: WatchInput) => projectWatch(input).briefing.verdict;

describe("Today's verdict (decision.md: Headline, Calm and bad mornings)", () => {
  it("calm: says nothing urgent, names the ready version and every fork flowing, with ○", () => {
    const view = projectWatch(calmInput());
    const version = view.briefing.facts.find(({ label }) => label === "Environment")?.figure;
    expect(version).toMatch(/^v\d/);
    expect(view.briefing.verdict).toEqual({
      text: `Nothing urgent needs you. ${version} is ready; all 13 forks are flowing.`,
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
      text: "1 thing needs you; 1 fork is stopped; 5 upstream changes need you before they land. Run approvals, the upstream radar and security alerts weren't read this sweep.",
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

  it("calm with deployability unproven never claims ready", () => {
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
      text: "Nothing urgent needs you. The environment isn't shown ready.",
      mark: "in-progress",
    });
  });

  describe("a maintenance hold leads as a line stop", () => {
    // A refresh after the last green one set maintenance at 08:02 and never cleared it.
    const held = (input: WatchInput, status: "failed" | "running"): WatchInput => {
      const lifecycle = input.facts.lifecycle.data;
      const green = lifecycle?.refresh.find((run) => run.conclusion === "success" && run.jobs);
      if (!lifecycle || !green) throw new Error("Fixture lacks a green refresh");
      const step = (name: string, conclusion: string | null, startedAt: string) => ({
        name,
        status: conclusion ? "completed" : "in_progress",
        conclusion,
        startedAt,
        completedAt: conclusion ? startedAt : null,
      });
      const run = {
        ...green,
        id: 99_000_001,
        createdAt: "2026-11-06T08:01:00Z",
        updatedAt: "2026-11-06T08:30:00Z",
        status: status === "running" ? "in_progress" : "completed",
        conclusion: status === "running" ? null : "failure",
        jobs: [
          {
            ...(green.jobs?.at(-1) as NonNullable<typeof green.jobs>[number]),
            name: "refresh",
            status: status === "running" ? "in_progress" : "completed",
            conclusion: status === "running" ? null : "failure",
            steps: [
              step("Quiesce (set maintenance)", "success", "2026-11-06T08:02:00Z"),
              step(
                "Wait for Flux Kustomizations to be Ready",
                status === "running" ? null : "failure",
                "2026-11-06T08:03:00Z",
              ),
              step(
                "Clear maintenance",
                status === "running" ? null : "skipped",
                "2026-11-06T08:30:00Z",
              ),
            ],
          },
        ],
      } as typeof green;
      input.facts.lifecycle.data = { ...lifecycle, refresh: [...lifecycle.refresh, run] };
      return input;
    };

    it("with nothing running it says how long, and counts the rest as other things", () => {
      const view = projectWatch(held(busyInput(), "failed"));
      const items = [...view.briefing.focus, ...view.briefing.rest];
      expect(items.filter((item) => item.attention === "interrupt").map((item) => item.id)).toEqual(
        ["sync-run:storage", "stack:99000001"],
      );
      expect(view.briefing.verdict).toEqual({
        text: "The environment has been in maintenance for 6\u00a0h, and nothing is running to clear it. 1 other thing needs you; 2 forks are stopped; 4 upstream changes need you before they land.",
        mark: "stopped",
      });
      expect(projectWatch(held(calmInput(), "failed")).briefing.verdict).toEqual({
        text: "The environment has been in maintenance for 6\u00a0h, and nothing is running to clear it.",
        mark: "stopped",
      });
    });

    it("with a run in flight it names the run", () => {
      expect(verdictOf(held(calmInput(), "running"))?.text).toMatch(
        /^The environment has been in maintenance for 6\u00a0h while a refresh runs\./,
      );
    });

    it("with lifecycle runs unread it says nothing about a hold, and the reading says not read", () => {
      const input = held(calmInput(), "failed");
      delete input.facts.lifecycle.data;
      const view = projectWatch(appStyle(input));
      expect(view.briefing.verdict?.text).not.toMatch(/maintenance/);
      const reading = view.readings.find(({ anchor }) => anchor.kind === "environment")?.content;
      expect(reading?.headline).toBe("The environment is not read yet.");
    });
  });
});
