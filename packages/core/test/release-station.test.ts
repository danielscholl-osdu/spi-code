// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { PrFact } from "../src/facts";
import { buildModel } from "../src/model/index";
import { FIXTURE_NOW, fixtureFacts } from "./harness";
import { fixtureContext } from "./model-fleet";

function releaseStation(change: (pr: PrFact) => void) {
  const facts = fixtureFacts();
  const repo = facts.github.data?.repos["Azure/osdu-spi-partition"];
  const recorded = facts.github.data?.repos["Azure/osdu-spi"]?.prs.find((pr) =>
    pr.head.startsWith("release-please--"),
  );
  if (!repo || !recorded) throw new Error("Missing recorded release PR or fork");
  const pr: PrFact = {
    ...structuredClone(recorded),
    repo: repo.repo,
    number: 198,
    reviewDecision: "APPROVED",
    mergeState: "CLEAN",
    draft: false,
  };
  expect(pr.checks.length).toBeGreaterThan(0);
  change(pr);
  repo.prs.push(pr);
  return buildModel(facts, FIXTURE_NOW, {}, fixtureContext)
    .lines.find((line) => line.fork.id === "partition")
    ?.stations.find((station) => station.id === "release");
}

describe("release station words", () => {
  test.each([
    ["APPROVED", "#198 ready"],
    ["REVIEW_REQUIRED", "#198 waiting on review"],
    ["CHANGES_REQUESTED", "#198 changes requested"],
  ])("names %s in the Line sheet", (review, text) => {
    expect(
      releaseStation((pr) => {
        pr.reviewDecision = review;
      }),
    ).toMatchObject({
      id: "release",
      state: "waiting",
      text,
    });
  });

  test.each([undefined, "", "UNKNOWN"])(
    "an unread or unknown review (%s) never reads ready",
    (review) => {
      expect(
        releaseStation((pr) => {
          pr.reviewDecision = review;
        })?.text,
      ).toBe("PR #198");
    },
  );

  test.each([
    [
      "a draft",
      (pr: PrFact) => {
        pr.draft = true;
      },
    ],
    [
      "conflicts",
      (pr: PrFact) => {
        pr.mergeState = "DIRTY";
      },
    ],
    [
      "unread merge state",
      (pr: PrFact) => {
        pr.mergeState = undefined;
      },
    ],
    [
      "unread checks",
      (pr: PrFact) => {
        pr.checks = [];
      },
    ],
    [
      "a failed check",
      (pr: PrFact) => {
        const check = pr.checks.find((check) => check.workflow);
        if (!check) throw new Error("Missing recorded check");
        check.conclusion = "FAILURE";
      },
    ],
    [
      "a running check",
      (pr: PrFact) => {
        const check = pr.checks.find((check) => check.workflow);
        if (!check) throw new Error("Missing recorded check");
        check.status = "IN_PROGRESS";
        check.conclusion = undefined;
      },
    ],
  ] as const)("an approved PR with %s never reads ready", (_, change) => {
    expect(releaseStation(change)?.text).toBe("PR #198");
  });
});
