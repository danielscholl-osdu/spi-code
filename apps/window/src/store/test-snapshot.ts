// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";

export function testSnapshot(overrides: Partial<ViewSnapshot> = {}): ViewSnapshot {
  const sweptAt = "2026-10-12T21:58:14.428Z";
  return ViewSnapshotSchema.parse({
    cursor: 1,
    sweptAt,
    briefing: JSON.parse(briefing),
    releases: JSON.parse(releases),
    stations: [
      {
        service: "legal",
        stations: [
          { id: "upstream", state: "moving", text: "Commits queued" },
          { id: "sync", state: "stopped", text: "Sync halted" },
          { id: "cascade", state: "idle", text: "" },
          { id: "main", state: "unknown", text: "" },
          { id: "release", state: "waiting", text: "Needs review" },
          { id: "lane", state: "stopped", text: "Environment held" },
        ],
      },
    ],
    tree: [{ id: "today", status: "failed" }],
    reads: [
      {
        source: "github",
        object: "osdu-spi",
        observedAt: sweptAt,
        completeness: { kind: "complete" },
      },
    ],
    selection: null,
    ...overrides,
  });
}
