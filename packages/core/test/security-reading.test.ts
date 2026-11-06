// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { attentionOf, LEAD_TIME_MS } from "../src/attention.js";
import { buildBriefing } from "../src/brief/index.js";
import { repositoriesOf } from "../src/brief/repos.js";
import type { ReadRecord } from "../src/evidence/index.js";
import { emptyFacts, type Facts } from "../src/facts.js";
import { detectCampaigns } from "../src/model/campaigns.js";
import { buildModel } from "../src/model/index.js";
import { internalNames, NOT_READ, readingText, wordCount } from "../src/readings/index.js";
import { type SecurityReadingItem, securityReading } from "../src/readings/security.js";
import { FIXTURE_NOW, fixtureFacts } from "./harness.js";
import { fixtureContext } from "./model-fleet.js";

function recorded(facts: Facts = fixtureFacts()) {
  const model = buildModel(facts, FIXTURE_NOW, {}, fixtureContext);
  const briefing = buildBriefing(
    model,
    { state: "clear", problems: [] },
    FIXTURE_NOW,
    fixtureContext,
  );
  const items: SecurityReadingItem[] = [...briefing.focus, ...briefing.rest].map((item) => ({
    ...item,
    attention: "ambient",
    owned: false,
  }));
  const campaigns = detectCampaigns(model);
  return { model, items, campaigns, reads: [] as ReadRecord[] };
}

describe("Security reading on the recorded sweep", () => {
  it("counts high findings like the repository security cells, and all owned findings separately", () => {
    const input = recorded();
    const cells = repositoriesOf(input.model, FIXTURE_NOW).rows;
    const high = cells.reduce(
      (sum, row) =>
        sum + Number(row.cells.vulnerabilities.text) + Number(row.cells.codeScanning.text),
      0,
    );
    expect(high).toBe(16);
    const reading = securityReading(input);
    expect(reading.tiles.map(({ value }) => value)).toEqual([String(high), "34", "81"]);
    expect(reading.tiles[0].counts).toContain("high or critical in SPI-owned shipped code");
    expect(reading.tiles[1].counts).toContain("SPI-owned findings at all severities");
    expect(reading.items.every((item) => item.cls === "SECURITY")).toBe(true);
    expect(wordCount(reading.headline)).toBeLessThanOrEqual(12);
    expect(readingText(reading).flatMap(internalNames)).toEqual([]);
    expect(reading.items).toHaveLength(5);
    expect(reading.folded).toMatch(/more (rule|package)/);
  });

  it("counts upstream-origin findings apart, never as SPI-owned work", () => {
    const facts = fixtureFacts();
    const alerts = facts.security.data?.["Azure/osdu-spi-file"]?.code;
    const base = alerts?.[0];
    if (!alerts || !base) throw new Error("Missing recorded file findings");
    alerts.push({
      ...base,
      number: 999,
      rule: "synthetic/upstream",
      description: "Upstream-only finding",
      path: "src/Upstream.java",
      severity: "critical",
    });
    const reading = securityReading(recorded(facts));
    expect(reading.tiles.map(({ value }) => value)).toEqual(["16", "34", "82"]);
    expect(reading.tiles[2].counts).toContain("upstream-owned findings at all severities");
    expect(readingText(reading).join(" ")).not.toContain("Upstream-only finding");
  });

  it("names Scorecard checks plainly and distinguishes repository settings from file reach", () => {
    const facts = fixtureFacts();
    const alerts = facts.security.data;
    const scorecard = alerts?.["Azure/osdu-spi"]?.code?.filter(
      (alert) =>
        alert.tool === "Scorecard" &&
        ["BranchProtectionID", "CodeReviewID", "TokenPermissionsID"].includes(alert.rule),
    );
    if (!alerts || !scorecard?.length) throw new Error("Missing recorded Scorecard findings");
    for (const repo of Object.keys(alerts)) alerts[repo] = { dependabot: [], code: [] };
    alerts["Azure/osdu-spi"] = { dependabot: [], code: scorecard };
    const reading = securityReading(recorded(facts));
    expect(reading.items).toHaveLength(3);
    expect(reading.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Scorecard: branch protection",
          sub: "1 SPI-owned finding · worst high · repository settings",
        }),
        expect.objectContaining({
          title: "Scorecard: code review",
          sub: "1 SPI-owned finding · worst high · repository settings",
        }),
        expect.objectContaining({
          title: "Scorecard: token permissions",
          sub: "5 SPI-owned findings · worst high · tooling",
        }),
      ]),
    );
  });

  it("shows each shared rule once as its detected campaign, not once per fork or path", () => {
    const input = recorded();
    const reading = securityReading(input);
    expect(input.campaigns).toHaveLength(2);
    for (const campaign of input.campaigns) {
      expect(reading.items.filter((item) => item.id === campaign.id)).toHaveLength(1);
      const item = reading.items.find((item) => item.id === campaign.id);
      const members = input.model.repositories.rows.flatMap((repo) =>
        repo.alerts
          .filter((g) => `${g.tool}: ${g.rule}` === campaign.fact && g.owner !== "upstream")
          .map((g) => `alert:${repo.repo}:${g.id}`),
      );
      expect(item?.ids).toEqual(expect.arrayContaining(members));
      expect(reading.items.filter((item) => members.includes(item.id))).toEqual([]);
    }
    expect(reading.items.find((item) => item.title.includes("Log Injection"))).toMatchObject({
      scope: "3 forks",
      sub: "7 SPI-owned findings · worst medium · shipped code",
    });
    expect(reading.folded).not.toMatch(/Log Injection|CSRF|partition|entitlements|schema|file/);
  });

  it("keeps projected attention and due times when grouping a rule's findings", () => {
    const input = recorded();
    const first = input.model.repositories.rows.find((row) => row.name === "osdu-spi")?.alerts[0];
    const base = input.items[0];
    if (!first || !base) throw new Error("Missing recorded items");
    const id = `alert:Azure/osdu-spi:${first.id}`;
    const due = { at: "2026-10-12T23:00:00Z", before: "the release" };
    input.items.push({
      ...base,
      id,
      ids: [id],
      cls: "SECURITY",
      attention: "interrupt",
      owned: true,
      due,
    });
    const reading = securityReading(input);
    expect(reading.items[0]).toMatchObject({
      id,
      attention: "interrupt",
      owned: true,
      due,
      group: "Needs you now",
    });
    expect(reading.items.slice(1).every((item) => item.group === "In the background")).toBe(true);
  });

  it("retains a critical shipped rule's projected queue attention and rung", () => {
    const facts = fixtureFacts();
    const alerts = facts.security.data;
    const base = alerts?.["Azure/osdu-spi-file"]?.code?.[0];
    if (!alerts || !base) throw new Error("Missing recorded file findings");
    for (const repo of Object.keys(alerts)) alerts[repo] = { dependabot: [], code: [] };
    alerts["Azure/osdu-spi-file"] = {
      dependabot: [],
      code: [
        {
          ...base,
          rule: "synthetic/critical",
          description: "Critical shipped rule",
          path: "provider/file-azure/Critical.java",
          severity: "critical",
        },
      ],
    };
    const input = recorded(facts);
    input.items = input.items.map((item) => ({
      ...item,
      ...attentionOf(item, input.model, { now: FIXTURE_NOW, leadTimeMs: LEAD_TIME_MS }),
    }));
    const queued = input.items.filter((item) => item.cls === "SECURITY");
    const queueId = "security:code:critical shipped rule";
    expect(queued).toMatchObject([{ id: queueId, ids: [queueId], attention: "surface", rung: 1 }]);
    const reading = securityReading(input);
    expect(reading.items).toMatchObject([
      {
        id: "alert:Azure/osdu-spi-file:code:CodeQL:synthetic/critical:provider/file-azure",
        ids: expect.arrayContaining([queueId]),
        title: "Critical shipped rule",
        attention: "surface",
        rung: 1,
        group: "Needs attention",
      },
    ]);
  });

  it("links a rule on exactly two forks, retaining the earliest projected due time", () => {
    const facts = fixtureFacts();
    for (const service of ["file", "schema"]) {
      const code = facts.security.data?.[`Azure/osdu-spi-${service}`]?.code;
      const base = code?.[0];
      if (!base || !code) throw new Error("Missing recorded code findings");
      code.push({
        ...base,
        number: 998,
        rule: "synthetic/shared",
        description: "Shared rule",
        path: `provider/${service}-azure/Synthetic.java`,
      });
    }
    const input = recorded(facts);
    const base = input.items[0];
    if (!base) throw new Error("Missing recorded items");
    for (const row of input.model.repositories.rows) {
      const alert = row.alerts.find((alert) => alert.rule === "synthetic/shared");
      if (!alert) continue;
      const id = `alert:${row.repo}:${alert.id}`;
      input.items.push({
        ...base,
        id,
        ids: [id],
        cls: "SECURITY",
        attention: "surface",
        due: {
          at: row.name === "file" ? "2026-10-12T23:00:00Z" : "2026-10-13T23:00:00Z",
          before: row.name === "file" ? "the release" : "the next release",
        },
      });
    }
    const reading = securityReading(input);
    expect(reading.items[0]).toMatchObject({
      id: "campaign:security:CodeQL%3A%20synthetic%2Fshared",
      title: "Detected: Shared rule",
      scope: "2 forks",
      group: "Before the release",
      due: { at: "2026-10-12T23:00:00Z", before: "the release" },
    });
    expect(reading.items.filter((item) => item.title.includes("Shared rule"))).toHaveLength(1);
    expect(reading.folded).not.toContain("Shared rule");
  });

  it("names the template copy in a shared fork campaign's scope, count and evidence", () => {
    const facts = fixtureFacts();
    const alerts = facts.security.data;
    const base = alerts?.["Azure/osdu-spi-file"]?.code?.[0];
    if (!alerts || !base) throw new Error("Missing recorded file findings");
    for (const repo of Object.keys(alerts)) alerts[repo] = { dependabot: [], code: [] };
    for (const name of ["osdu-spi", "osdu-spi-file", "osdu-spi-schema"]) {
      alerts[`Azure/${name}`] = {
        dependabot: [],
        code: [
          {
            ...base,
            rule: "synthetic/shared",
            description: "Shared rule",
            url: `https://github.com/Azure/${name}/security/code-scanning/${base.number}`,
            path:
              name === "osdu-spi"
                ? "src/Shared.java"
                : `provider/${name.replace("osdu-spi-", "")}-azure/Shared.java`,
          },
        ],
      };
    }
    const reading = securityReading(recorded(facts));
    expect(reading.items).toHaveLength(1);
    expect(reading.items[0]).toMatchObject({
      id: "campaign:security:CodeQL%3A%20synthetic%2Fshared",
      title: "Detected: Shared rule",
      scope: "2 forks, osdu-spi",
      sub: "3 SPI-owned findings · worst medium · shipped code",
      ids: expect.arrayContaining([
        "alert:Azure/osdu-spi:code:CodeQL:synthetic/shared:src",
        "alert:Azure/osdu-spi-file:code:CodeQL:synthetic/shared:provider/file-azure",
        "alert:Azure/osdu-spi-schema:code:CodeQL:synthetic/shared:provider/schema-azure",
      ]),
      evidence: expect.arrayContaining([
        expect.objectContaining({ label: "osdu-spi findings" }),
        expect.objectContaining({ label: "file findings" }),
        expect.objectContaining({ label: "schema findings" }),
      ]),
    });
    expect(reading.items[0]?.evidence).toHaveLength(3);
    expect(reading.tiles.map((tile) => tile.value)).toEqual(["0", "3", "0"]);
  });

  it("groups paths by rule identity, not matching descriptions, and strips title emoji", () => {
    const facts = fixtureFacts();
    const alerts = facts.security.data;
    const base = alerts?.["Azure/osdu-spi"]?.code?.[0];
    if (!alerts || !base) throw new Error("Missing recorded template findings");
    base.severity = "high";
    for (const repo of Object.keys(alerts)) alerts[repo] = { dependabot: [], code: [] };
    alerts["Azure/osdu-spi"] = {
      dependabot: [],
      code: [
        {
          ...base,
          rule: "synthetic/a",
          description: "\u{1f6a8} Same description",
          path: "src/A.ts",
        },
        {
          ...base,
          rule: "synthetic/a",
          description: "\u{1f6a8} Same description",
          path: "tools/B.ts",
        },
        {
          ...base,
          rule: "synthetic/b",
          description: "\u{1f6a8} Same description",
          path: "src/C.ts",
        },
      ],
    };
    const reading = securityReading(recorded(facts));
    expect(reading.items).toHaveLength(2);
    expect(reading.items.map((item) => item.title)).toEqual([
      "Scorecard: same description",
      "Scorecard: same description",
    ]);
    expect(new Set(reading.items.map((item) => item.id)).size).toBe(2);
    expect(reading.items.map((item) => item.ids.length)).toEqual([2, 1]);
    expect(reading.tiles.map((tile) => tile.value)).toEqual(["2", "3", "0"]);
    expect(reading.folded).toBeNull();
    alerts["Azure/osdu-spi"] = {
      dependabot: [],
      code: [{ ...base, severity: "critical", path: "tools/Check.ts" }],
    };
    const tooling = securityReading(recorded(facts));
    expect(tooling.tiles.map((tile) => tile.value)).toEqual(["0", "1", "0"]);
    expect(tooling.headline).toBe("1 SPI-owned finding remains across the lists read.");
  });
});

describe("Security evidence", () => {
  it("keeps unread and hidden lists distinct from a measured zero", () => {
    const unread = securityReading(recorded(emptyFacts()));
    expect(unread.headline).toBe("Security not read yet.");
    expect(unread.tiles.map((tile) => tile.value)).toEqual([NOT_READ, NOT_READ, NOT_READ]);
    expect(unread.items).toEqual([]);
    expect(unread.folded).toBeNull();
    const facts = fixtureFacts();
    if (!facts.security.data) throw new Error("Missing recorded security data");
    for (const repo of Object.keys(facts.security.data))
      facts.security.data[repo] = { dependabot: [], code: [] };
    expect(securityReading(recorded(facts)).tiles.map((tile) => tile.value)).toEqual([
      "0",
      "0",
      "0",
    ]);
    delete facts.security.data["Azure/osdu-spi-file"]?.code;
    const partial = securityReading(recorded(facts));
    expect(partial.tiles.every((tile) => tile.counts.includes("1 list not read yet"))).toBe(true);
    expect(partial.headline).toBe("No SPI-owned findings in the lists read.");
    expect(partial).not.toHaveProperty("qualifier");
  });

  it("qualifies only failed or incomplete security provenance", () => {
    const input = recorded();
    const read: ReadRecord = {
      source: "Azure/osdu-spi-file",
      object: "security",
      observedAt: FIXTURE_NOW.toISOString(),
      completeness: { kind: "complete" },
    };
    expect(securityReading({ ...input, reads: [read] })).not.toHaveProperty("qualifier");
    expect(
      securityReading({ ...input, reads: [{ ...read, failure: "Synthetic read failure" }] })
        .qualifier,
    ).toContain("security read failed");
    expect(
      securityReading({
        ...input,
        reads: [
          { ...read, completeness: { kind: "cut", reason: "Synthetic limit", read: 1, total: 2 } },
        ],
      }).qualifier,
    ).toContain("security read was incomplete");
  });
});
