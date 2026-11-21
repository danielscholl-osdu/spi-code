// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { fixtureLoader } from "../test-utils/harness.js";
import {
  type Reach,
  SECURITY_READING_GONE,
  securityReadingCases,
  securityReadingFields,
} from "./reachability.test-helper.js";
import { assertReach, container, openHome, shellHooks } from "./reachability-shell.test-helper.js";

shellHooks(readFixture);
const loadFixture = fixtureLoader(readFixture);

describe.each(["snapshot-59d6895.json", "snapshot-busy.json"] as const)(
  "what the old Security place drew from the security reading, on %s",
  (name) => {
    const body = loadFixture(name);
    const cases = securityReadingCases(body);
    const homes = new Map<string, Reach[]>();
    for (const row of cases.filter(({ exempt }) => !exempt))
      homes.set(row.home.name, [...(homes.get(row.home.name) ?? []), row]);

    it("has a home on the page or a reason it is gone for every field", () => {
      const fields = securityReadingFields(body);
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.filter((pointer) => !cases.some((row) => row.pointer === pointer))).toEqual([]);
      const reasons = new Set(Object.values(SECURITY_READING_GONE));
      expect(cases.filter(({ exempt }) => exempt && !reasons.has(exempt))).toEqual([]);
    });

    it.each([...homes].map(([home, rows]) => [home, rows] as const))(
      "reaches %s within one click",
      async (_home, rows) => {
        const [first] = rows;
        if (!first) throw new Error("No rows");
        await openHome(first.home, body);
        expect(container.querySelector(".security-pane")).not.toBeNull();
        expect(container.querySelector(".place-reading")).toBeNull();
        for (const row of rows) assertReach(row);
      },
    );
  },
);
