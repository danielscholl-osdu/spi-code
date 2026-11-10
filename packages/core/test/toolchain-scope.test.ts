// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { CampaignSchema } from "@spi-code/contracts";
import { expect, test } from "vitest";
import { buildBriefing } from "../src/brief/index.js";
import { fleetOf } from "../src/config.js";
import { createContext } from "../src/context.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { campaignItemText, detectCampaigns } from "../src/model/campaigns.js";
import { buildModel } from "../src/model/index.js";
import { upstreamReading } from "../src/readings/index.js";

const now = new Date("2026-11-06T08:00:00Z");
const context = createContext({
  fleet: fleetOf(
    ["indexer", "unit", "workflow"].map((id) => ({
      id,
      repo: `example/${id}`,
      upstream: `example/${id}`,
      prefix: id,
      seeded: "2026-01-01",
    })),
  ),
});

function predictedMove(): Facts {
  const facts = emptyFacts();
  facts.github.data = { repos: {}, planned: {} };
  facts.radar.data = { services: {}, filters: {} };
  for (const fork of context.fleet.forks) {
    const diff = {
      paths: ["pom.xml"],
      hunks: { "pom.xml": ["+<os-core-common.version>8.5.0</os-core-common.version>"] },
    };
    facts.radar.data.filters[fork.id] = {
      sha: "filter-sha",
      text: `service: ${fork.id}\ntop_level:\n  pom.xml: keep\n`,
    };
    facts.radar.data.services[fork.id] = {
      project: fork.upstream,
      queued:
        fork.id === "workflow"
          ? []
          : [
              {
                ...diff,
                sha: "move-sha",
                title: "Move library",
                at: now.toISOString(),
                url: "https://example.test/commit",
              },
            ],
      mrs: [
        {
          ...diff,
          iid: 1,
          title: "Move library",
          author: "maintainer",
          draft: false,
          labels: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          headSha: "move-sha",
          url: "https://example.test/mr/1",
        },
      ],
    };
  }
  return facts;
}

test("one toolchain prediction set preserves two certain forks and one possible fork on both surfaces", () => {
  const model = buildModel(predictedMove(), now, {}, context);
  const theme = buildBriefing(model, { state: "clear", problems: [] }, now, context).themes.find(
    (theme) => theme.title === "os-core-common 8.5.0",
  );
  const campaign = detectCampaigns(model).find((campaign) => campaign.fact === theme?.title);
  expect(theme).toBeDefined();
  expect(campaign).toBeDefined();
  if (!theme || !campaign) throw new Error("Missing predicted toolchain move");
  expect(theme.certain.map(({ fork }) => fork).sort()).toEqual(["indexer", "unit"]);
  expect(theme.possible.map(({ fork }) => fork)).toEqual(["workflow"]);
  expect(campaign.forks).toEqual(["indexer", "unit", "workflow"]);
  expect(CampaignSchema.parse(campaign)).toMatchObject({ possible: ["workflow"] });
  expect(campaignItemText(campaign)).toBe(
    "Detected: os-core-common 8.5.0 on 2 forks; possible on 1 fork",
  );
  const briefing = buildBriefing(model, { state: "clear", problems: [] }, now, context);
  model.upstream.unread = 0;
  const reading = upstreamReading({
    model,
    items: [...briefing.focus, ...briefing.rest],
    radar: [],
    fleet: context.fleet,
    campaigns: [campaign],
  });
  expect(reading.items.find((item) => item.id === campaign.id)?.sub).toBe(
    "Certain: indexer, unit · Possible: workflow",
  );
  expect(reading.tiles[1].counts).toBe("os-core-common 8.5.0 · 2 certain, 1 possible");
});

test("delivery state never removes a predicted fork from a toolchain campaign", () => {
  const facts = predictedMove();
  const radar = facts.radar.data;
  if (!radar) throw new Error("Missing synthetic radar");
  const workflow = radar.services.workflow;
  const indexer = radar.services.indexer;
  if (!workflow || !indexer) throw new Error("Missing synthetic services");
  workflow.queued = structuredClone(indexer.queued);
  const model = buildModel(facts, now, {}, context);
  model.upstream.moving = [];
  const campaign = detectCampaigns(model)[0];
  const theme = buildBriefing(model, { state: "clear", problems: [] }, now, context).themes[0];
  expect(campaign?.forks).toEqual(["indexer", "unit", "workflow"]);
  expect(theme?.certain.map(({ fork }) => fork).sort()).toEqual(campaign?.forks);
  expect(theme?.possible).toEqual([]);
  expect(campaign?.possible).toBeUndefined();
});

test("unmerged moves remain possible even when none is certain", () => {
  const facts = predictedMove();
  for (const service of Object.values(facts.radar.data?.services ?? {})) service.queued = [];
  const model = buildModel(facts, now, {}, context);
  const campaign = detectCampaigns(model)[0];
  const theme = buildBriefing(model, { state: "clear", problems: [] }, now, context).themes[0];
  expect(theme?.certain).toEqual([]);
  expect(theme?.possible.map(({ fork }) => fork).sort()).toEqual(["indexer", "unit", "workflow"]);
  expect(campaign?.possible).toEqual(campaign?.forks);
  expect(campaign && campaignItemText(campaign)).toBe(
    "Detected: os-core-common 8.5.0 on 0 forks; possible on 3 forks",
  );
});
