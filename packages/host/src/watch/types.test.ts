// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { Briefing, ReleaseDoc } from "@spi-code/contracts";
import { buildBriefing, buildModel, monthFacts, releaseDoc } from "@spi-code/core";
import { expect, it } from "vitest";
import { fixtureInput } from "../../test/watch/snapshot-fixture.js";

process.env.TZ = "UTC";

it("core Briefing and ReleaseDoc are assignable to the pane contracts", () => {
  const input = fixtureInput();
  const now = input.context.clock.now();
  const model = buildModel(input.facts, now, {}, input.context);
  const coreBriefing = buildBriefing(model, input.doctor, now, input.context);
  const briefing: Briefing = coreBriefing;
  const doc: ReleaseDoc = releaseDoc(
    monthFacts(input.releases, "2026-10", now, input.context),
    undefined,
    now,
  );
  expect(briefing.headline).toBe(coreBriefing.headline);
  expect(doc.month).toBe("2026-10");

  const { headline: _headline, ...dropped } = coreBriefing;
  // @ts-expect-error A Briefing missing its headline cannot satisfy the pane contract.
  const missingHeadline: Briefing = dropped;
  expect(missingHeadline).not.toHaveProperty("headline");
});
