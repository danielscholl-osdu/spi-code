// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { CampaignSchema } from "@spi-code/contracts";
import { buildModel, campaignItemText, detectCampaigns } from "@spi-code/core";
import { expect, test } from "vitest";
import { fixtureInput } from "../../test/watch/snapshot-fixture.js";
import { detectedCampaigns } from "./campaigns.js";
import { projectWatch } from "./project.js";

test("projects core's detected security campaigns and their reading anchors", () => {
  const input = fixtureInput();
  const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
  const expected = detectCampaigns(model);
  expect(expected).toHaveLength(4);
  expect(detectedCampaigns(model, input)).toEqual(expected);
  const snapshot = projectWatch(input);
  expect(snapshot.campaigns).toEqual(expected.map((campaign) => CampaignSchema.parse(campaign)));
  expect(expected.filter((campaign) => campaign.kind === "security").map(campaignItemText)).toEqual(
    [
      "Detected: CodeQL: java/log-injection on 3 forks",
      "Detected: CodeQL: java/spring-disabled-csrf-protection on 5 forks",
    ],
  );
  expect(snapshot.readings.filter(({ anchor }) => anchor.kind === "campaign")).toEqual(
    expected.map(({ id }) => ({ anchor: { kind: "campaign", id }, content: null })),
  );
});
