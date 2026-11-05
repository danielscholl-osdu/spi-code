// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { Facts, PrFact } from "../src/facts";
import { buildModel } from "../src/model/index";
import { fixtureContext } from "./briefing-setup";
import { settled } from "./flow-states";
import { FIXTURE_NOW, releasedFacts as released } from "./harness";

function dependabotPr(repo: string, number: number): PrFact {
  return {
    repo,
    number,
    title: "build(deps): bump spring-boot",
    url: `https://github.com/${repo}/pull/${number}`,
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:00:00Z",
    draft: false,
    head: `dependabot/maven/spring-boot-${number}`,
    base: "main",
    headSha: "d0d0",
    author: "dependabot",
    labels: [],
    checks: [],
  };
}

function model(edit?: (f: Facts) => void) {
  const f = settled(released());
  edit?.(f);
  return buildModel(f, FIXTURE_NOW, {}, fixtureContext);
}

describe("the template rollout", () => {
  test("each fork's row reads its position, PR, review and open Dependabot PRs", () => {
    const m = model((f) => {
      const repos = f.github.data?.repos;
      repos?.["Azure/osdu-spi-entitlements"]?.prs.push(
        dependabotPr("Azure/osdu-spi-entitlements", 52),
        dependabotPr("Azure/osdu-spi-entitlements", 54),
      );
      const legal = repos?.["Azure/osdu-spi-legal"]?.prs.find((p) => p.number === 33);
      if (legal) legal.reviewDecision = "APPROVED";
    });
    const row = (svc: string) => m.template.rows.find((r) => r.service === svc);
    expect(row("schema")?.label).toBe("v1.2.0 +2");
    expect(row("entitlements")?.pr?.number).toBe(48);
    expect(row("entitlements")?.dependabot.map((p) => p.number)).toEqual([52, 54]);
    expect(row("file")?.dependabot).toEqual([]);
    expect(row("legal")?.pr?.reviewDecision).toBe("APPROVED");
  });

  test("a template-sync PR failing on its own counts as failing; one red on the stack does not", () => {
    const m = model((f) => {
      const file = f.github.data?.repos["Azure/osdu-spi-file"]?.prs.find((p) => p.number === 51);
      const deploy = file?.checks.find((c) => c.name === "Deploy and Test");
      const key = `Azure/osdu-spi-file#${deploy?.id}`;
      const detail = f.details.data?.[key];
      if (!detail || !f.details.data) throw new Error("file #51 Deploy and Test");
      f.details.data[key] = { ...detail, failedStep: "Prove", reason: "2 acceptance tests failed" };
    });
    const step = m.template.steps.find((s) => s.label === "v1.2.0 +2");
    expect(step?.failing).toEqual(["file"]);
    expect(step?.waiting).toHaveLength(3);
  });

  test("a red PR on osdu-spi is a P1", () => {
    const m = model((f) => {
      f.github.data?.repos["Azure/osdu-spi"]?.prs.push({
        ...dependabotPr("Azure/osdu-spi", 263),
        checks: [
          { id: 9, name: "Lint", workflow: "CI", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      });
    });
    const item = m.queue.items.find((i) => i.id === "template-pr:263");
    expect(item?.rung).toBe(1);
    expect(item?.text).toMatch(/· fails Lint$/);
  });
});
