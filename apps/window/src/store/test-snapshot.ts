// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AREAS, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";

export function testSnapshot(
  briefing: string,
  releases: string,
  overrides: Partial<ViewSnapshot> = {},
): ViewSnapshot {
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
    areas: AREAS.map((area) => ({ area, envelope: { source: area, state: "unread" } })),
    provenance: [],
    selection: null,
    ...overrides,
  });
}
