// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { upstreamView } from "../src/brief/upstream";
import { builtInFleet, fleetOf } from "../src/config";
import { createContext } from "../src/context";
import { emptyFacts, type Facts } from "../src/facts";
import { factsSchema } from "../src/facts-schema";
import { campaignItemText, detectCampaigns } from "../src/model/campaigns";
import { buildModel } from "../src/model/index";
import recording from "./fixtures/upstream-1106.json";
import { FIXTURE_NOW, fixtureFacts } from "./harness";
import { fixtureContext } from "./model-fleet";
import { UPSTREAM_SERVICES } from "./upstream-states";

const context = createContext({ fleet: fleetOf(builtInFleet(UPSTREAM_SERVICES)) });
const now = new Date(recording.sweep.at);
const recordedFacts = (): Facts => factsSchema.parse({ ...emptyFacts(), ...recording });
const modelOf = (facts: Facts = recordedFacts()) => buildModel(facts, now, {}, context);
const releasedForks = [
  "crs-conversion",
  "file",
  "indexer",
  "schema",
  "search",
  "storage",
  "unit",
  "workflow",
];

describe("detected campaigns", () => {
  test("groups exactly the eight unheld 8.5.0 forks on the recorded November 6 sweep", () => {
    const model = modelOf();
    const campaigns = detectCampaigns(model);
    expect(campaigns).toEqual([
      {
        id: "campaign:toolchain:os-core-common%208.5.0",
        kind: "toolchain",
        fact: "os-core-common 8.5.0",
        forks: releasedForks,
      },
    ]);
    const campaign = campaigns[0];
    if (!campaign) throw new Error("Missing recorded campaign");
    expect(campaignItemText(campaign)).toBe("Detected: os-core-common 8.5.0 on 8 forks");
    for (const fork of releasedForks) {
      expect(
        model.radar.services[fork]?.certain.some((v) => v.value === "os-core-common 8.5.0"),
      ).toBe(true);
    }
  });

  test("does not turn a one-fork SNAPSHOT fact or possible MR into a campaign", () => {
    const model = modelOf();
    expect(model.upstream.moves.find((move) => move.value.includes("SNAPSHOT"))?.forks).toEqual([
      "legal",
    ]);
    expect(detectCampaigns(model).some((campaign) => campaign.fact.includes("SNAPSHOT"))).toBe(
      false,
    );
    expect(
      model.radar.services.schema?.certain.some((v) => v.value === "os-core-common 10.0.0"),
    ).toBe(true);
    expect(
      detectCampaigns(model).some((campaign) => campaign.fact === "os-core-common 10.0.0"),
    ).toBe(false);
    model.upstream.moves.push({ value: "Java 25", forks: ["file", "file"] });
    expect(detectCampaigns(model).some((campaign) => campaign.fact === "Java 25")).toBe(false);
    const facts = recordedFacts();
    for (const service of Object.values(facts.radar.data?.services ?? {})) service.queued = [];
    expect(detectCampaigns(modelOf(facts))).toEqual([]);
    expect(detectCampaigns(modelOf(emptyFacts()))).toEqual([]);
  });

  test("keeps ids stable when fork order, membership and other detected facts change", () => {
    const model = modelOf();
    const original = detectCampaigns(model)[0];
    model.upstream.moves.reverse();
    for (const move of model.upstream.moves) move.forks.reverse();
    expect(detectCampaigns(model)[0]).toEqual(original);
    model.upstream.moves.unshift({ value: "Java 25", forks: ["file", "schema"] });
    const released = model.upstream.moves.find((move) => move.value === original?.fact);
    if (!released) throw new Error("Missing recorded toolchain target");
    released.forks.pop();
    expect(detectCampaigns(model).find((campaign) => campaign.fact === original?.fact)?.id).toBe(
      original?.id,
    );
    const campaign = detectCampaigns(model).find((item) => item.fact === "Java 25");
    expect(campaign).toBeDefined();
    if (!campaign) throw new Error("Missing Java campaign");
    expect(campaignItemText(campaign)).toBe("Detected: Java 25 on 2 forks");
  });

  test("removes shared targets from stations and flow rows, retaining fork-specific facts and Detail", () => {
    const model = modelOf();
    const campaign = detectCampaigns(model)[0];
    if (!campaign) throw new Error("Missing recorded campaign");
    const view = upstreamView(model.upstream, now);
    for (const fork of campaign.forks) {
      const line = model.lines.find((line) => line.fork.id === fork);
      const row = view.rows.find((row) => row.fork === fork);
      expect(line?.stations.find((station) => station.id === "upstream")?.text).not.toContain(
        campaign.fact,
      );
      expect(row?.carries).not.toContain(campaign.fact);
      expect(row?.detail.lines.join(" ")).toContain(campaign.fact);
      expect(line?.stations[0]?.text).toMatch(new RegExp(`^${line?.upstream?.lag} behind`));
    }
    expect(model.lines.find((line) => line.fork.id === "partition")?.stations[0]?.text).toContain(
      "will halt on schemathesis-tests",
    );
    expect(model.lines.find((line) => line.fork.id === "storage")?.stations[0]?.text).toContain(
      "in the sync PR",
    );
    expect(model.lines.find((line) => line.fork.id === "schema")?.stations[0]?.text).toContain(
      "os-core-common 10.0.0 queued",
    );
    expect(model.lines.find((line) => line.fork.id === "legal")?.stations[0]?.text).toContain(
      "os-core-common 8.4.1-boot4-SNAPSHOT queued",
    );
    expect(model.radar.services.schema?.certain.some((v) => v.value === campaign.fact)).toBe(true);
  });

  test("groups SPI-owned code rules across forks, not paths, alerts or matching descriptions", () => {
    const facts = fixtureFacts();
    const model = buildModel(facts, FIXTURE_NOW, {}, fixtureContext);
    expect(detectCampaigns(model)).toEqual([
      {
        id: "campaign:security:CodeQL%3A%20java%2Flog-injection",
        kind: "security",
        fact: "CodeQL: java/log-injection",
        forks: ["file", "partition", "schema"],
      },
      {
        id: "campaign:security:CodeQL%3A%20java%2Fspring-disabled-csrf-protection",
        kind: "security",
        fact: "CodeQL: java/spring-disabled-csrf-protection",
        forks: ["entitlements", "file", "legal", "partition", "schema"],
      },
    ]);
    const alerts = facts.security.data;
    if (!alerts) throw new Error("Missing recorded alerts");
    const alert = {
      number: 1,
      rule: "synthetic/rule",
      description: "Same description",
      tool: "CodeQL",
      url: "https://example.test/alert",
      createdAt: FIXTURE_NOW.toISOString(),
    };
    for (const fork of fixtureContext.fleet.forks) {
      alerts[fork.repo] = {
        code: [
          { ...alert, path: `provider/${fork.prefix}-azure/A.java` },
          { ...alert, number: 2, path: `testing/${fork.prefix}-test-azure/B.java` },
          { ...alert, rule: "synthetic/upstream", path: "pom.xml" },
          {
            ...alert,
            tool: fork.id,
            rule: "synthetic/unique",
            path: `provider/${fork.prefix}-azure/A.java`,
          },
        ],
      };
    }
    const synthetic = detectCampaigns(buildModel(facts, FIXTURE_NOW, {}, fixtureContext));
    expect(synthetic).toEqual([
      {
        id: "campaign:security:CodeQL%3A%20synthetic%2Frule",
        kind: "security",
        fact: "CodeQL: synthetic/rule",
        forks: ["entitlements", "file", "legal", "partition", "schema"],
      },
    ]);
  });
});
