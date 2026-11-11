// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { briefingVerdict, type VerdictInput } from "../src/brief/verdict.js";
import { AREAS } from "../src/facts.js";

const PLACE_AREAS = [
  "github",
  "runs",
  "approvals",
  "lifecycle",
  "details",
  "upstream",
  "radar",
  "template",
  "security",
] as const;

function calm(over: Partial<VerdictInput> = {}): VerdictInput {
  return {
    items: [],
    horizon: { cards: [], counts: { needYouCards: 0 } },
    stoppedForks: [],
    forks: 13,
    deployable: { state: "yes" },
    version: "v0.35.5",
    places: [{ areas: [...PLACE_AREAS] }],
    areas: AREAS.map((area) => ({ area, envelope: { state: "fresh" } })),
    ...over,
  };
}

const withState = (states: Partial<Record<(typeof AREAS)[number], string>>) =>
  AREAS.map((area) => ({ area, envelope: { state: states[area] ?? "fresh" } }));

describe("briefingVerdict", () => {
  test("calm reads as calm, with an Ambient item still running", () => {
    expect(
      briefingVerdict(calm({ items: [{ id: "rollout", attention: "ambient", origin: "system" }] })),
    ).toEqual({
      text: "Nothing urgent needs you. v0.35.5 is deployable; all 13 forks are flowing.",
      mark: "nothing-due",
    });
  });

  test("names the decision.md bad morning in its own words", () => {
    expect(
      briefingVerdict(
        calm({
          items: [
            { id: "a", attention: "interrupt", origin: "system" },
            { id: "b", attention: "interrupt", origin: "system" },
            { id: "c", attention: "interrupt", origin: "upstream" },
            { id: "d", attention: "surface", origin: "upstream" },
          ],
          horizon: { cards: [{ itemIds: ["c", "d"] }], counts: { needYouCards: 1 } },
          stoppedForks: ["entitlements", "legal", "storage", "indexer-queue"],
          areas: withState({ github: "failed" }),
        }),
      ),
    ).toEqual({
      text: "3 things need you; 4 forks are stopped. GitHub wasn't read this sweep.",
      mark: "stopped",
    });
  });

  test("names each origin at its loudest tier and counts upstream changes as horizon cards", () => {
    expect(
      briefingVerdict(
        calm({
          items: [
            { id: "sync-run:storage", attention: "interrupt", origin: "system" },
            { id: "gate2:file", attention: "surface", origin: "system" },
            { id: "radar:indexer", attention: "surface", origin: "upstream" },
            { id: "radar:unit", attention: "surface", origin: "upstream" },
            { id: "gate1:unit", attention: "surface", origin: "upstream" },
            { id: "radar:legal", attention: "surface", origin: "upstream" },
          ],
          horizon: {
            cards: [
              { itemIds: ["radar:indexer", "radar:unit", "gate1:unit"] },
              { itemIds: ["radar:legal"] },
            ],
            counts: { needYouCards: 2 },
          },
        }),
      ),
    ).toEqual({
      text: "1 thing needs you; 2 upstream changes need you before they land.",
      mark: "stopped",
    });
  });

  test("one change across two forks is one upstream change", () => {
    const input = calm({
      items: [
        { id: "radar:indexer", attention: "surface", origin: "upstream" },
        { id: "radar:storage", attention: "surface", origin: "upstream" },
      ],
      horizon: {
        cards: [{ itemIds: ["radar:indexer", "radar:storage"] }],
        counts: { needYouCards: 1 },
      },
    });
    const expected = { text: "1 upstream change needs you before it lands.", mark: "needs-person" };
    expect(briefingVerdict(input)).toEqual(expected);
    expect(briefingVerdict({ ...input, horizon: { cards: input.horizon.cards } })).toEqual(
      expected,
    );
  });

  test("an in-system decision shows when nothing in the system interrupts", () => {
    expect(
      briefingVerdict(
        calm({
          items: [
            { id: "halt:legal", attention: "interrupt", origin: "upstream" },
            { id: "gate2:file", attention: "surface", origin: "system" },
          ],
          horizon: { cards: [{ itemIds: ["halt:legal"] }], counts: { needYouCards: 1 } },
        }),
      ),
    ).toEqual({ text: "1 thing needs you; 1 decision waits on you.", mark: "stopped" });
  });

  test("an upstream Surface item no card holds still counts once, upstream", () => {
    expect(
      briefingVerdict(
        calm({
          items: [
            { id: "radar:indexer", attention: "surface", origin: "upstream" },
            { id: "port:entitlements", attention: "surface", origin: "upstream" },
          ],
          horizon: { cards: [{ itemIds: ["radar:indexer"] }], counts: { needYouCards: 1 } },
        }),
      ),
    ).toEqual({
      text: "2 upstream changes need you before they land.",
      mark: "needs-person",
    });
  });

  test("stopped forks alone stop the verdict", () => {
    expect(briefingVerdict(calm({ stoppedForks: ["storage"] }))).toEqual({
      text: "1 fork is stopped.",
      mark: "stopped",
    });
  });

  describe("fails toward the quieter, honest state", () => {
    test("an unread area takes the caveat and never the calm mark", () => {
      expect(briefingVerdict(calm({ areas: withState({ security: "unread" }) }))).toEqual({
        text: "Nothing read needs you. Security alerts weren't read this sweep.",
        mark: "in-progress",
      });
    });

    test("a stale area is not proof of calm", () => {
      expect(briefingVerdict(calm({ areas: withState({ runs: "stale" }) }))).toEqual({
        text: "Nothing read needs you. Workflow runs weren't read this sweep.",
        mark: "in-progress",
      });
    });

    test("a cut area says so", () => {
      expect(briefingVerdict(calm({ areas: withState({ radar: "incomplete" }) }))).toEqual({
        text: "Nothing read needs you. The upstream radar wasn't fully read this sweep.",
        mark: "in-progress",
      });
    });

    test("an area with no envelope counts as unread", () => {
      expect(
        briefingVerdict(calm({ areas: calm().areas.filter(({ area }) => area !== "github") })),
      ).toEqual({
        text: "Nothing read needs you. GitHub wasn't read this sweep.",
        mark: "in-progress",
      });
    });

    test("every area unread says nothing was read", () => {
      expect(
        briefingVerdict(
          calm({ areas: AREAS.map((area) => ({ area, envelope: { state: "unread" } })) }),
        ),
      ).toEqual({
        text: "Nothing read needs you. Nothing was read this sweep.",
        mark: "in-progress",
      });
    });

    test.each([
      ["unknown", "Nothing urgent needs you. The environment isn't shown deployable."],
      ["no", "Nothing urgent needs you. The environment isn't deployable."],
    ] as const)("deployability %s is never claimed", (state, text) => {
      expect(briefingVerdict(calm({ deployable: { state } }))).toEqual({
        text,
        mark: "in-progress",
      });
    });

    test("an unread fleet withholds calm: the fork count rests on it", () => {
      expect(briefingVerdict(calm({ areas: withState({ fleet: "failed" }) }))).toEqual({
        text: "Nothing read needs you. Fleet membership wasn't read this sweep.",
        mark: "in-progress",
      });
    });

    test("no forks read is not calm", () => {
      expect(briefingVerdict(calm({ forks: 0 }))).toEqual({
        text: "Nothing urgent needs you. No forks were read.",
        mark: "in-progress",
      });
    });

    test("no declared or reported areas is not calm", () => {
      expect(briefingVerdict(calm({ places: [], areas: [] }))).toEqual({
        text: "Nothing read needs you. Fleet membership wasn't read this sweep.",
        mark: "in-progress",
      });
    });
  });
});
