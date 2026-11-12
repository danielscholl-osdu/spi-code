// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import {
  RELEASES_QUIET,
  TODAY_RELEASES,
  todayReleasesCases,
} from "../views/today/releases.test-helper.js";
import { coverage, openerCases, STARTS } from "./reachability.test-helper.js";
import {
  assertOpens,
  assertReach,
  badSnapshot,
  busySnapshot,
  calmSnapshot,
  container,
  fixture,
  openHome,
  shellHooks,
} from "./reachability-shell.test-helper.js";

shellHooks();

describe("Today's Releases block, on every morning", () => {
  const MORNINGS = {
    "6 Nov": fixture,
    calm: () => structuredClone(calmSnapshot),
    busy: () => structuredClone(busySnapshot),
    bad: () => structuredClone(badSnapshot),
  };
  describe.each(Object.entries(MORNINGS))("%s morning", (_name, morning) => {
    const body = morning();
    const rows = todayReleasesCases(body, { name: "Today", start: STARTS.today });
    it("has a reachable case for every leaf it draws", async () => {
      const mine = coverage(body, rows, RELEASES_QUIET).uncovered.filter((pointer) =>
        TODAY_RELEASES.test(pointer),
      );
      expect(mine).toEqual([]);
      await openHome(rows[0]?.home ?? { name: "Today", start: STARTS.today }, body);
      for (const row of rows) assertReach(row);
    });
    it.each(
      openerCases(rows.filter(({ opens }) => opens)).map(({ name, rows }) => [name, rows] as const),
    )("opens %s and lands where it says", async (_name, rows) => {
      const scrolled = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
      try {
        await assertOpens(rows, body);
        const row = rows[0];
        const place = row?.opens && "place" in row.opens ? row.opens.place : undefined;
        if (place?.kind !== "releases" || !place.section) return;
        const section = container.querySelector(`#${place.section}`);
        expect(section, row?.pointer).not.toBeNull();
        expect(scrolled.mock.contexts, row?.pointer).toContain(section);
      } finally {
        scrolled.mockRestore();
      }
    });
  });
});
