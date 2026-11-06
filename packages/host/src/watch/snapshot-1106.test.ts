// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { ViewSnapshot } from "@spi-code/contracts";
import { describe, expect, it } from "vitest";
import { projectWatch } from "./project.js";
import { recordedInput, recordedSnapshotPath } from "./snapshot-fixture.js";

process.env.TZ = "UTC";

const snapshot: ViewSnapshot = JSON.parse(readFileSync(recordedSnapshotPath, "utf8"));

describe("the projected 6 Nov recorded sweep", () => {
  it("matches a fresh projection", () => {
    expect(projectWatch(recordedInput())).toEqual(snapshot);
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

  it("lists exactly the eight forks moving to os-core-common 8.5.0", () => {
    const campaign = snapshot.campaigns.find(({ fact }) => fact === "os-core-common 8.5.0");
    expect(campaign?.forks).toEqual([
      "crs-conversion",
      "file",
      "indexer",
      "schema",
      "search",
      "storage",
      "unit",
      "workflow",
    ]);
  });
});
