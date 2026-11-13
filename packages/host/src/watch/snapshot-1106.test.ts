// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { ViewSnapshot } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import {
  acknowledgedInput,
  acknowledgedSnapshotPath,
  appStyle,
  recordedInput,
  recordedSnapshotPath,
  unreadForksInput,
  unreadSnapshotPath,
  unverifiedForkInput,
  unverifiedSnapshotPath,
} from "../../test/watch/snapshot-fixture.js";
import { projectWatch } from "./project.js";

process.env.TZ = "UTC";

const snapshot: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));

describe("the projected 6 Nov recorded sweep", () => {
  it("matches a fresh projection", () => {
    expect(projectWatch(appStyle(recordedInput()))).toEqual(snapshot);
  });

  it("reads legal as 17 commits incoming, a SNAPSHOT hold and release PR #48 passing", () => {
    const legal = snapshot.readings.find(
      ({ anchor }) => anchor.kind === "service" && anchor.id === "legal",
    )?.content;
    expect(legal?.tiles[0]).toMatchObject({ label: "Upstream", value: "17" });
    expect(legal?.headline).toContain("SNAPSHOT");
    expect(legal?.items.find((item) => item.id === "radar:legal")?.sub).toMatch(
      /^17 commits queued/,
    );
    expect(legal?.tiles[2]).toMatchObject({ label: "Release review", value: "PR #48" });
    expect(legal?.tiles[2]?.counts).toMatch(/^checks pass/);
  });

  it("lists all ten forks predicted to move to os-core-common 8.5.0, including held forks", () => {
    const campaign = snapshot.campaigns.find(({ fact }) => fact === "os-core-common 8.5.0");
    expect(campaign?.forks).toEqual([
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
    ]);
  });
});

describe("the 6 Nov sweep with five forks' GitHub reads failed", () => {
  const unread: ViewSnapshot = JSON.parse(readFixture(unreadSnapshotPath));

  it("matches a fresh projection", () => {
    expect(projectWatch(appStyle(unreadForksInput()))).toEqual(unread);
  });

  it("counts the engineering system over all 13 forks and names the 5 not read", () => {
    expect(unread.briefing.facts[2]).toMatchObject({
      label: "Template · main 7d269b5",
      figure: "0 of 13",
      sub: "on main · 5 not read yet · 1 change reaches the forks · 8 of 13 on v1.4.0",
    });
    const reading = unread.readings.find(({ anchor }) => anchor.kind === "engineering")?.content;
    expect(reading?.tiles[0]).toEqual({
      label: "Engineering system",
      value: "0 of 13",
      counts: "forks on 7d269b5 · 5 not read yet",
    });
    expect(reading?.verifiedTemplate).toMatchObject({ total: 13, unread: 5 });
  });

  it("leaves the fact unchanged when every fork is read", () => {
    expect(snapshot.briefing.facts[2]).toMatchObject({
      figure: "0 of 13",
      sub: "on main · 1 change reaches the forks · 13 of 13 on v1.4.0",
    });
  });
});

describe("the 6 Nov sweep with partition verified and legal merged but red on main", () => {
  const unverified: ViewSnapshot = JSON.parse(readFixture(unverifiedSnapshotPath));
  const reading = unverified.readings.find(({ anchor }) => anchor.kind === "engineering")?.content;

  it("matches a fresh projection", () => {
    expect(projectWatch(appStyle(unverifiedForkInput()))).toEqual(unverified);
  });

  it("puts two forks on 7d269b5 and counts only the verified one (PS-09, PS-18)", () => {
    expect(reading?.items[0]?.sub).toBe(
      "2 of 13 merged · 1 main run green · 1 red · 11 forks held",
    );
    expect(unverified.briefing.facts[2]).toMatchObject({
      label: "Template · main 7d269b5",
      figure: "1 of 13",
    });
    expect(reading?.tiles[0]).toEqual({
      label: "Engineering system",
      value: "1 of 13",
      counts: "forks on 7d269b5",
    });
    expect(reading?.verifiedTemplate).toMatchObject({ verified: 1, total: 13, unread: 0 });
  });
});

describe("the 6 Nov sweep pushed again after its first push was acknowledged", () => {
  const acknowledged: ViewSnapshot = JSON.parse(readFixture(acknowledgedSnapshotPath));

  it("matches a fresh projection", () => {
    expect(projectWatch(appStyle(acknowledgedInput()))).toEqual(acknowledged);
  });

  it("holds the acknowledged baseline with nothing new and its Interrupt still open (AU-09)", () => {
    expect(acknowledged.cursor).toBe(snapshot.cursor + 1);
    expect(acknowledged.seen).toEqual({
      cursor: snapshot.cursor,
      since: [],
      at: "2026-11-06T14:05:00.000Z",
    });
    const open = [...acknowledged.briefing.focus, ...acknowledged.briefing.rest].filter(
      ({ attention }) => attention === "interrupt",
    );
    expect(open.map(({ id }) => id)).toEqual(["conflict:entitlements:121"]);
    expect(acknowledged.briefing).toEqual(snapshot.briefing);
  });
});
