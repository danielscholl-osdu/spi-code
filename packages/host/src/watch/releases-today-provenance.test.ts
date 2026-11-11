// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ReleasesToday, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import type { ReadRecord } from "@spi-code/core";
import { describe, expect, it } from "vitest";
import { projectWatch } from "./project.js";
import { releaseProvenance, releasesTodayProvenance } from "./provenance.js";
import { fixtureInput, recordedInput } from "./snapshot-fixture.js";

const today: ReleasesToday = {
  versions: [
    {
      service: "partition",
      released: "1.4.1",
      proposed: "1.4.2",
      pr: { number: 41, url: "https://github.com/example/partition/pull/41" },
      coreLibAzure: "5.0.0",
      text: "released 1.4.1, proposed 1.4.2",
    },
    { service: "legal", released: "2.0.0", text: "released 2.0.0" },
  ],
  platform: {
    stack: "v0.35.3",
    template: {
      released: "v1.4.0",
      proposed: "1.5.0",
      pr: { number: 263, url: "https://github.com/example/template/pull/263" },
    },
    coreLibAzure: [{ version: "5.0.0", count: 1 }],
    text: "stack v0.35.3 · template v1.4.0 → 1.5.0 · core-lib-azure 5.0.0 (5.0.0 on 1 of 2)",
  },
  readyLine: "1 release PR waits for review, none failing",
  unread: { areas: ["releases"], lastGood: "2026-11-06T12:00:00Z" },
};

const leaves = (value: unknown, at: string): string[] =>
  value !== null && typeof value === "object"
    ? Object.entries(value).flatMap(([key, child]) => leaves(child, `${at}/${key}`))
    : [at];

const record: ReadRecord = {
  source: "github-releases",
  object: "Azure/osdu-spi",
  observedAt: "2026-11-06T12:00:00Z",
  completeness: { kind: "complete" },
};
const now = new Date("2026-11-10T12:00:00Z");

const bindings = (sources: ReturnType<typeof releasesTodayProvenance>) =>
  Object.fromEntries(
    sources.map(({ path, areas, envelope }) => [
      path.replace("/releases/today", ""),
      envelope ? [...areas, `+${envelope.source}`] : areas,
    ]),
  );

describe("Today release provenance", () => {
  it("binds each Today release field to the reads that built it", () => {
    expect(
      bindings(
        releasesTodayProvenance(today, [record], now, { stack: "ledger", template: "github" }),
      ),
    ).toEqual({
      "/versions/0/service": ["fleet", "+releases"],
      "/versions/0/released": ["fleet", "+releases"],
      "/versions/0/coreLibAzure": ["fleet", "+releases"],
      "/versions/0/proposed": ["github"],
      "/versions/0/pr": ["github"],
      "/versions/0/text": ["fleet", "github", "+releases"],
      "/versions/1/service": ["fleet", "+releases"],
      "/versions/1/released": ["fleet", "+releases"],
      "/versions/1/text": ["fleet", "+releases"],
      "/platform/stack": ["fleet", "+releases"],
      "/platform/template/released": ["fleet", "github", "+releases"],
      "/platform/template/proposed": ["github"],
      "/platform/template/pr": ["github"],
      "/platform/coreLibAzure": ["fleet", "+releases"],
      "/platform/text": ["fleet", "github", "+releases"],
      "/readyLine": ["github", "details"],
      "/unread": ["fleet", "+releases"],
    });
  });

  it("binds no platform version, or the line that names it, whose source is not known", () => {
    const sources = bindings(releasesTodayProvenance(today, [record], now));
    for (const path of ["/platform/stack", "/platform/template/released", "/platform/text"]) {
      expect(sources, path).not.toHaveProperty([path]);
    }
    expect(sources["/platform/template/proposed"]).toEqual(["github"]);
    expect(sources["/platform/coreLibAzure"]).toEqual(["fleet", "+releases"]);
    const partial = bindings(releasesTodayProvenance(today, [record], now, { stack: "ledger" }));
    expect(partial["/platform/stack"]).toEqual(["fleet", "+releases"]);
    expect(partial).not.toHaveProperty(["/platform/text"]);
  });

  it("binds a platform line with nothing in it to the ledger alone", () => {
    const empty = { ...today, platform: { coreLibAzure: [], text: "" } };
    const sources = bindings(releasesTodayProvenance(empty, [record], now));
    expect(sources["/platform/text"]).toEqual(["fleet", "+releases"]);
    expect(sources).not.toHaveProperty(["/platform/stack"]);
  });

  it("never gives a GitHub-fed field the release reader's envelope or the fleet", () => {
    const sources = releasesTodayProvenance(today, [record], now, {
      stack: "ledger",
      template: "ledger",
    });
    for (const suffix of ["/proposed", "/pr", "/readyLine"]) {
      for (const source of sources.filter(({ path }) => path.endsWith(suffix))) {
        expect(source.envelope, source.path).toBeUndefined();
        expect(source.areas, source.path).not.toContain("fleet");
      }
    }
  });

  it("binds nothing when Today has no release fields", () => {
    expect(releasesTodayProvenance(undefined, [record], now)).toEqual([]);
  });

  it("binds each projected platform version to the read that supplied it", () => {
    const at = (snapshot: ViewSnapshot, path: string) =>
      snapshot.provenance.find((source) => source.path === `/releases/today${path}`);
    const ledgerFed = projectWatch(fixtureInput());
    for (const path of ["/platform/stack", "/platform/template/released"]) {
      expect(at(ledgerFed, path), path).toMatchObject({ areas: ["fleet"] });
    }
    const tagFed = projectWatch(recordedInput());
    expect(tagFed.releases.today?.platform).toMatchObject({
      stack: "v0.35.3",
      template: { released: "v1.4.0" },
    });
    for (const path of ["/platform/stack", "/platform/template/released"]) {
      expect(at(tagFed, path), path).toMatchObject({
        areas: ["fleet", "github"],
        envelope: { source: "releases", state: "unread" },
      });
    }
    for (const snapshot of [ledgerFed, tagFed]) {
      const bound = snapshot.provenance.map(({ path }) => path);
      expect(
        leaves(snapshot.releases.today, "/releases/today").filter(
          (leaf) => !bound.some((path) => leaf === path || leaf.startsWith(`${path}/`)),
        ),
      ).toEqual([]);
    }
  });

  it("adds Today bindings to a valid snapshot without changing the month ledger's", () => {
    const projected = projectWatch(fixtureInput());
    const ledger = projected.provenance.filter(({ path }) => path.startsWith("/releases/lines"));
    expect(ledger.map(({ path }) => path)).toEqual([
      ...projected.releases.lines.map((_, i) => `/releases/lines/${i}`),
      "/releases/lines",
    ]);
    expect(ledger).toEqual(
      releaseProvenance(projected.releases.lines, fixtureInput().releaseRecords, now).map(
        ({ path, areas }) => expect.objectContaining({ path, areas }),
      ),
    );
    const added = releasesTodayProvenance(today, [record], now, {
      stack: "ledger",
      template: "github",
    });
    const snapshot = {
      ...projected,
      releases: { ...projected.releases, today },
      provenance: [
        ...projected.provenance.filter(({ path }) => !path.startsWith("/releases/today/")),
        ...added,
      ],
    };
    expect(ViewSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.provenance.filter(({ path }) => path.startsWith("/releases/lines"))).toEqual(
      ledger,
    );
    expect(snapshot.provenance.some(({ path }) => path === "/releases")).toBe(false);
    const bound = added.map(({ path }) => path);
    expect(
      leaves(today, "/releases/today").filter(
        (leaf) => !bound.some((path) => leaf === path || leaf.startsWith(`${path}/`)),
      ),
    ).toEqual([]);
  });
});
