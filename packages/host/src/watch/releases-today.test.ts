// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { TEMPLATE_REPO } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { projectWatch } from "./project.js";
import { busyInput, recordedInput } from "./snapshot-fixture.js";

describe("Today's release versions", () => {
  it("keeps all 13 released versions, pairs only open PRs, and carries each library pin", () => {
    const snapshot = projectWatch(busyInput());
    const today = snapshot.releases.today;
    expect(today?.versions).toHaveLength(13);
    for (const service of snapshot.services ?? []) {
      const release = service.releases[0];
      const version = today?.versions.find((v) => v.service === service.service);
      expect(version?.released).toBe(release?.to ?? release?.version);
      expect(version?.coreLibAzure).toBe(release?.lib);
      if (release?.releasePr) {
        expect(version).toMatchObject({
          proposed: "1.5.0",
          pr: { number: release.releasePr.number, url: release.releasePr.url },
          text: `released ${release.to ?? release.version}, proposed 1.5.0`,
        });
      } else {
        expect(version).not.toHaveProperty("proposed");
        expect(version).not.toHaveProperty("pr");
        expect(version?.text).toBe(`released ${release?.to ?? release?.version}`);
      }
    }
  });

  it("proposes only proven versions from plain or component release titles", () => {
    for (const [title, proposed] of [
      ["chore(main): release storage 1.4.2", "1.4.2"],
      ["chore: release main", undefined],
      ["release notes for november", undefined],
      ["chore: release v1.4.2-rc.1+build.2", "1.4.2-rc.1+build.2"],
      ["chore: release 1.4.2oops", undefined],
    ] as const) {
      const input = busyInput();
      for (const repo of Object.values(input.facts.github.data?.repos ?? {})) {
        for (const pr of repo.prs) {
          if (pr.head.startsWith("release-please--") || pr.labels.includes("autorelease: pending"))
            pr.title = title;
        }
      }
      const today = projectWatch(input).releases.today;
      const pairs = [
        ...(today?.versions.filter((v) => v.service === "storage") ?? []),
        today?.platform.template,
      ];
      expect(pairs).toHaveLength(2);
      for (const pair of pairs) {
        expect(pair).toBeDefined();
        if (proposed) {
          expect(pair?.proposed).toBe(proposed);
          expect(pair?.pr).toBeDefined();
        } else {
          expect(pair).not.toHaveProperty("proposed");
          expect(pair).not.toHaveProperty("pr");
        }
      }
      const storage = today?.versions.find((v) => v.service === "storage");
      expect(storage?.text).toBe(
        `released ${storage?.released}${proposed ? `, proposed ${proposed}` : ""}`,
      );
    }
  });

  it("agrees in number and names requested changes in the ready line", () => {
    const input = busyInput();
    const template = input.facts.github.data?.repos[TEMPLATE_REPO];
    const pr = template?.prs.find((pr) => pr.number === 263);
    if (!template || !pr) throw new Error("Busy fixture needs the template release PR");
    for (const repo of Object.values(input.facts.github.data?.repos ?? {})) repo.prs = [];
    template.prs = [pr];
    pr.reviewDecision = "CHANGES_REQUESTED";
    expect(projectWatch(input).releases.today?.readyLine).toBe(
      "1 release PR has changes requested, none failing",
    );
    const other = { ...pr, number: 264, reviewDecision: "REVIEW_REQUIRED" };
    template.prs.push(other);
    expect(projectWatch(input).releases.today?.readyLine).toBe(
      "2 release PRs open: 1 waits for review, 1 has changes requested, none failing",
    );
    other.reviewDecision = "CHANGES_REQUESTED";
    expect(projectWatch(input).releases.today?.readyLine).toBe(
      "2 release PRs have changes requested, none failing",
    );
    template.prs = [other];
    other.reviewDecision = "REVIEW_REQUIRED";
    expect(projectWatch(input).releases.today?.readyLine).toBe(
      "1 release PR waits for review, none failing",
    );
  });

  it("counts the template PR in the heading and names its released and proposed versions", () => {
    const input = busyInput();
    const today = projectWatch(input).releases.today;
    expect(today?.readyLine).toBe("9 release PRs wait for review, none failing");
    expect(today?.platform).toMatchObject({
      stack: "v0.35.3",
      template: { released: "v1.4.0", proposed: "1.5.0", pr: { number: 263 } },
    });
    expect(today?.platform.text).toContain("stack v0.35.3 · template v1.4.0 → 1.5.0");
    const template = input.facts.github.data?.repos[TEMPLATE_REPO];
    if (!template) throw new Error("Busy fixture needs the template repo");
    template.prs = template.prs.filter((pr) => pr.number !== 263);
    const without = projectWatch(input).releases.today;
    expect(without?.readyLine).toBe("8 release PRs wait for review, none failing");
    expect(without?.platform.template).toEqual({ released: "v1.4.0" });
  });

  it("sums the spread from exactly the versions carried on its 13 services", () => {
    const today = projectWatch(busyInput()).releases.today;
    const counts = new Map<string, number>();
    for (const version of today?.versions ?? []) {
      expect(version.coreLibAzure).toBeDefined();
      if (version.coreLibAzure)
        counts.set(version.coreLibAzure, (counts.get(version.coreLibAzure) ?? 0) + 1);
    }
    expect(today?.platform.coreLibAzure).toEqual([
      { version: "5.0.0", count: 2 },
      { version: "4.0.0", count: 4 },
      { version: "3.0.1", count: 6 },
      { version: "2.5.10", count: 1 },
    ]);
    expect(
      new Map(today?.platform.coreLibAzure.map(({ version, count }) => [version, count])),
    ).toEqual(counts);
    expect(today?.platform.text).toContain("core-lib-azure 2.5.10 to 5.0.0 (5.0.0 on 2 of 13)");
    expect(today).not.toHaveProperty("unread");
  });

  it("marks the 1106 release area unread without inventing a last good time", () => {
    const snapshot = projectWatch(recordedInput());
    expect(snapshot.provenance.find((p) => p.path === "/releases/lines")?.envelope).toEqual({
      source: "releases",
      state: "unread",
    });
    expect(snapshot.releases.today?.unread).toEqual({ areas: ["releases"] });
    expect(snapshot.releases.today?.versions.every((v) => v.released === "?")).toBe(true);
    expect(snapshot.releases.today?.platform.template).toMatchObject({
      released: "v1.4.0",
      proposed: "1.5.0",
      pr: { number: 263 },
    });
  });

  it("carries the releases provenance's last good time on a failed retained read", () => {
    const input = busyInput();
    const lastGood = "2026-11-06T12:00:00Z";
    const snapshot = projectWatch({
      ...input,
      releaseRecords: [
        {
          source: "releases",
          object: "releases",
          observedAt: input.context.clock.now().toISOString(),
          completeness: { kind: "complete" },
          failure: "offline",
          retainedFrom: lastGood,
        },
      ],
    });
    expect(snapshot.releases.today?.unread).toEqual({ areas: ["releases"], lastGood });
    expect(snapshot.releases.today?.versions).toEqual(projectWatch(input).releases.today?.versions);
  });
});
