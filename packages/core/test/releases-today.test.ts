// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type ReleasesTodayInput, releasesToday } from "../src/brief/releases-today.js";
import { TEMPLATE_REPO } from "../src/config.js";
import { fixtureContext } from "./briefing-setup.js";
import { fixtureFacts } from "./harness.js";

function input(
  state = "released",
  version = "1.4.1",
  title = "chore: release 1.5.0",
  to?: string,
): ReleasesTodayInput {
  const facts = fixtureFacts();
  const repo = facts.github.data?.repos[TEMPLATE_REPO];
  const pr = repo?.prs[0];
  if (!repo || !pr) throw new Error("Fixture needs template PR");
  repo.prs = [
    {
      ...pr,
      number: 263,
      title,
      head: "release-please--branches--main",
      labels: ["autorelease: pending"],
    },
  ];
  return {
    context: fixtureContext,
    facts,
    provenance: [],
    services: [
      {
        service: "storage",
        releases: [
          {
            id: "storage",
            month: "2026-11",
            state,
            version,
            ...(to ? { to } : {}),
            releasePr: {
              number: 75,
              title,
              url: "https://github.com/example/storage/pull/75",
            },
          },
        ],
      },
    ],
    documents: [
      { month: "2026-11", rows: [{ id: "spi-template", state: "released", version: "1.4.1" }] },
    ],
  };
}

describe("Today version states", () => {
  it("writes no-release words for a never-cut service", () => {
    const version = releasesToday(input("unreleased", "no release")).versions[0];
    expect(version).toEqual({ service: "storage", state: "none", text: "no release yet" });
  });

  it("does not promote an unread row with a retained to version to released or none", () => {
    const data = input("unread", "?", "chore: release 1.5.0", "1.4.1");
    const version = releasesToday(data).versions[0];
    expect(version).toEqual({ service: "storage", state: "unread", text: "release not read" });
  });

  it("carries a released state with the actual to version", () => {
    const data = input("released", "1.3.0 → 1.4.1", "chore: release 1.5.0", "1.4.1");
    expect(releasesToday(data).versions[0]).toMatchObject({
      state: "released",
      released: "1.4.1",
      proposed: "1.5.0",
      text: "released 1.4.1, proposed 1.5.0",
    });
  });

  it.each(["1.2.1", "1.4.1", "v1.4.1"])(
    "omits an older or equal %s proposal for services and template",
    (version) => {
      const data = input("released", "1.4.1", `chore: release ${version}`);
      const today = releasesToday(data);
      for (const pair of [today.versions[0], today.platform.template]) {
        expect(pair).toBeDefined();
        expect(pair).not.toHaveProperty("proposed");
        expect(pair).not.toHaveProperty("pr");
      }
      expect(today.versions[0]?.text).toBe("released 1.4.1");
      expect(today.platform.text).toContain("template 1.4.1");
      expect(today.platform.text).not.toContain("→");
    },
  );
});
