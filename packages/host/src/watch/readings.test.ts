// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { buildModel, type ReadRecord, TEMPLATE_REPO } from "@spi-code/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as campaigns from "./campaigns.js";
import { projectWatch, type WatchInput } from "./project.js";
import { readingFor } from "./readings.js";
import { fixtureInput, recordedInput } from "./snapshot-fixture.js";

process.env.TZ = "UTC";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Watch projection", () => {
  describe("current release tile without a whole release read", () => {
    const observedAt = "2026-11-06T12:00:00.000Z";
    const record = (over: Partial<ReadRecord> = {}): ReadRecord => ({
      source: "github-releases",
      object: "Azure/osdu-spi-file",
      observedAt,
      completeness: { kind: "complete" },
      ...over,
    });
    const currentRelease = (releaseRecords: ReadRecord[]) => {
      const input: WatchInput = {
        ...fixtureInput(),
        releases: { releases: {}, created: {}, pins: {}, errors: {} },
        releaseRecords,
      };
      const releases = projectWatch(input).readings.find(
        ({ anchor }) => anchor.kind === "releases",
      );
      return releases?.content?.tiles[2];
    };
    const unread = { label: "Current release", value: "not read yet" };

    it.each([
      ["no release reads", []],
      [
        "only a cut read",
        [record({ completeness: { kind: "cut", reason: "page limit", read: 100, total: 140 } })],
      ],
      ["only a failed read", [record({ failure: "HTTP 502" })]],
    ])("reads not read yet with %s", (_case, records) => {
      expect(currentRelease(records)).toMatchObject(unread);
    });

    it("reads the months when a failed read kept an earlier one", () => {
      expect(
        currentRelease([record({ failure: "HTTP 502", retainedFrom: "2026-11-05T12:00:00.000Z" })]),
      ).toMatchObject({ label: "Current release", value: "2026.10" });
    });
  });

  it("does not qualify engineering adoption on a failed radar read from a fork", () => {
    const input = fixtureInput();
    const snapshot = projectWatch({
      ...input,
      reads: {
        ...input.reads,
        radar: [
          {
            source: "Azure/osdu-spi-partition",
            object: "main:provider/partition-azure/pom.xml",
            observedAt: input.context.clock.now().toISOString(),
            completeness: { kind: "complete" },
            failure: "unavailable",
          },
        ],
      },
    });
    expect(
      snapshot.readings.find(({ anchor }) => anchor.kind === "engineering")?.content,
    ).not.toHaveProperty("qualifier");
  });

  it("preserves typed template verification through the host snapshot projection", () => {
    const input = recordedInput();
    const repo = input.facts.github.data?.repos["Azure/osdu-spi-partition"];
    if (!repo) throw new Error("Missing partition");
    delete repo.marker;
    const snapshot = projectWatch(input);
    const model = buildModel(input.facts, input.context.clock.now(), {}, input.context);
    expect(
      snapshot.readings.find(({ anchor }) => anchor.kind === "engineering")?.content
        ?.verifiedTemplate,
    ).toEqual({
      verified: 0,
      total: 13,
      unread: 1,
      target: model.rollout?.target.sha ?? model.template.head?.sha,
    });
    expect(ViewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it.each(["template", "runs"] as const)(
    "names failed %s reads in the engineering qualifier",
    (area) => {
      const input = fixtureInput();
      const snapshot = projectWatch({
        ...input,
        reads: {
          ...input.reads,
          [area]: [
            {
              source: area === "template" ? TEMPLATE_REPO : "Azure/osdu-spi-partition",
              object: area === "template" ? "compare" : "actions/runs",
              observedAt: input.context.clock.now().toISOString(),
              completeness: { kind: "complete" },
              failure: "unavailable",
            },
          ],
        },
      });
      const source = area === "template" ? "GitHub template" : "GitHub Actions";
      expect(
        snapshot.readings.find(({ anchor }) => anchor.kind === "engineering")?.content?.qualifier,
      ).toBe(`${source} reads failed, so adoption or template changes could be missing.`);
    },
  );

  it("dispatches every reading to its own anchor-kind handler with the full context", () => {
    const input = fixtureInput();
    const detected = [
      {
        id: "boot",
        kind: "toolchain" as const,
        fact: "Boot 4",
        forks: ["legal", "file"],
      },
    ];
    vi.spyOn(campaigns, "detectedCampaigns").mockReturnValue(detected);
    const handlers = (
      [
        "program",
        "upstream",
        "environment",
        "engineering",
        "releases",
        "security",
        "service",
        "release-month",
        "campaign",
      ] as const
    ).map((kind) => ({ kind, spy: vi.spyOn(readingFor, kind) }));
    const snapshot = projectWatch(input);
    for (const { kind, spy } of handlers) {
      const entries = snapshot.readings.filter(({ anchor }) => anchor.kind === kind);
      expect(entries.length).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalledTimes(entries.length);
      for (const { anchor } of entries)
        expect(spy).toHaveBeenCalledWith(
          anchor,
          expect.objectContaining({ input, briefing: snapshot.briefing, campaigns: detected }),
        );
    }
  });
});
