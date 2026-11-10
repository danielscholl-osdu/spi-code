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
  "legal",
  "partition",
  "schema",
  "search",
  "storage",
  "unit",
  "workflow",
];

describe("detected campaigns", () => {
  test("groups every queued toolchain move with exact members on the recorded November 6 sweep", () => {
    const model = modelOf();
    const campaigns = detectCampaigns(model);
    expect(campaigns).toEqual([
      {
        id: "campaign:toolchain:os-core-common%2010.0.0",
        kind: "toolchain",
        fact: "os-core-common 10.0.0",
        forks: [
          "crs-catalog",
          "crs-conversion",
          "file",
          "indexer",
          "legal",
          "partition",
          "schema",
          "search",
          "storage",
          "unit",
          "workflow",
        ],
        possible: [
          "crs-catalog",
          "crs-conversion",
          "file",
          "legal",
          "partition",
          "search",
          "storage",
          "workflow",
        ],
      },
      {
        id: "campaign:toolchain:os-core-common%208.5.0",
        kind: "toolchain",
        fact: "os-core-common 8.5.0",
        forks: releasedForks,
      },
    ]);
    expect(campaigns.map(campaignItemText)).toEqual([
      "Detected: os-core-common 10.0.0 on 3 forks; possible on 8 forks",
      "Detected: os-core-common 8.5.0 on 10 forks",
    ]);
    for (const campaign of campaigns) {
      for (const fork of campaign.forks.filter((fork) => !campaign.possible?.includes(fork)))
        expect(model.radar.services[fork]?.certain.some((v) => v.value === campaign.fact)).toBe(
          true,
        );
    }
  });

  test("excludes single-fork facts and retains unmerged MR moves as possible campaigns", () => {
    const model = modelOf();
    expect(model.upstream.moves.find((move) => move.value.includes("SNAPSHOT"))?.forks).toEqual([
      "legal",
    ]);
    expect(detectCampaigns(model).some((campaign) => campaign.fact.includes("SNAPSHOT"))).toBe(
      false,
    );
    const file = model.upstream.moving.find((fork) => fork.service === "file");
    if (!file?.moves) throw new Error("Missing file's recorded moves");
    file.moves.push("Java 25", "Java 25");
    expect(detectCampaigns(model).some((campaign) => campaign.fact === "Java 25")).toBe(false);
    const facts = recordedFacts();
    for (const service of Object.values(facts.radar.data?.services ?? {})) service.queued = [];
    const possible = detectCampaigns(modelOf(facts));
    expect(possible).toHaveLength(1);
    expect(possible[0]?.possible).toEqual(possible[0]?.forks);
    expect(detectCampaigns(modelOf(emptyFacts()))).toEqual([]);
  });

  test("keeps ids stable when fork order, membership and other detected facts change", () => {
    const model = modelOf();
    const original = detectCampaigns(model);
    model.upstream.moving.reverse();
    for (const fork of model.upstream.moving) fork.moves?.reverse();
    expect(detectCampaigns(model)).toEqual(original);
    const file = model.radar.services.file;
    const schema = model.radar.services.schema;
    if (!file || !schema) throw new Error("Missing recorded toolchain targets");
    file.certain.push({ bucket: "Toolchain", value: "Java 25", paths: ["pom.xml"] });
    schema.certain.push({ bucket: "Toolchain", value: "Java 25", paths: ["pom.xml"] });
    file.certain = file.certain.filter((verdict) => verdict.value !== "os-core-common 8.5.0");
    for (const previous of original)
      expect(detectCampaigns(model).find((campaign) => campaign.fact === previous.fact)?.id).toBe(
        previous.id,
      );
    const campaign = detectCampaigns(model).find((item) => item.fact === "Java 25");
    expect(campaign).toBeDefined();
    if (!campaign) throw new Error("Missing Java campaign");
    expect(campaignItemText(campaign)).toBe("Detected: Java 25 on 2 forks");
  });

  test("removes shared targets from stations and flow rows, retaining fork-specific facts and Detail", () => {
    const model = modelOf();
    const campaigns = detectCampaigns(model);
    expect(campaigns).toHaveLength(2);
    const view = upstreamView(model.upstream, now);
    for (const campaign of campaigns) {
      for (const fork of campaign.forks.filter((fork) => !campaign.possible?.includes(fork))) {
        const line = model.lines.find((line) => line.fork.id === fork);
        const row = view.rows.find((row) => row.fork === fork);
        expect(line?.stations.find((station) => station.id === "upstream")?.text).not.toContain(
          campaign.fact,
        );
        expect(row?.carries).not.toContain(campaign.fact);
        if (campaign.fact === "os-core-common 8.5.0" && !["legal", "partition"].includes(fork))
          expect(row?.detail.lines.join(" ")).toContain(campaign.fact);
        expect(model.radar.services[fork]?.certain.some((v) => v.value === campaign.fact)).toBe(
          true,
        );
        expect(line?.stations[0]?.text).toMatch(new RegExp(`^${line?.upstream?.lag} behind`));
      }
    }
    expect(model.lines.find((line) => line.fork.id === "partition")?.stations[0]?.text).toContain(
      "will halt on schemathesis-tests",
    );
    expect(model.lines.find((line) => line.fork.id === "storage")?.stations[0]?.text).toContain(
      "in the sync PR",
    );
    expect(model.lines.find((line) => line.fork.id === "schema")?.stations[0]?.text).toContain(
      "port owed",
    );
    expect(model.lines.find((line) => line.fork.id === "legal")?.stations[0]?.text).toContain(
      "os-core-common 8.4.1-boot4-SNAPSHOT queued",
    );
  });

  test("groups SPI-owned code rules across forks, not paths, alerts or matching descriptions", () => {
    const facts = fixtureFacts();
    const model = buildModel(facts, FIXTURE_NOW, {}, fixtureContext);
    expect(detectCampaigns(model).filter((campaign) => campaign.kind === "security")).toEqual([
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
    const synthetic = detectCampaigns(buildModel(facts, FIXTURE_NOW, {}, fixtureContext)).filter(
      (campaign) => campaign.kind === "security",
    );
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
