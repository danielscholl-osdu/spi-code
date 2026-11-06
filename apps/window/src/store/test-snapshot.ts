// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { AREAS, BriefingSchema, type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";

export function testSnapshot(
  briefing: string,
  releases: string,
  overrides: Partial<ViewSnapshot> = {},
): ViewSnapshot {
  const sweptAt = "2026-10-12T21:58:14.428Z";
  const core = BriefingSchema.parse(JSON.parse(briefing));
  return ViewSnapshotSchema.parse({
    cursor: 1,
    sweptAt,
    briefing: {
      ...core,
      focus: core.focus.map((item) => ({ ...item, attention: "ambient", owned: false })),
      rest: core.rest.map((item) => ({ ...item, attention: "ambient", owned: false })),
    },
    campaigns: [],
    readings: [],
    seen: { cursor: null, since: [] },
    releases: JSON.parse(releases),
    stations: [
      {
        service: "legal",
        stations: [
          { id: "upstream", state: "moving", substate: "in-progress", text: "Commits queued" },
          { id: "sync", state: "stopped", substate: "stopped", text: "Sync halted" },
          { id: "cascade", state: "idle", substate: "ready", text: "" },
          { id: "main", state: "unknown", substate: "ready", text: "" },
          { id: "release", state: "waiting", substate: "ready", text: "Needs review" },
          { id: "lane", state: "stopped", substate: "stopped", text: "Environment held" },
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

/**
 * The host's mixed-source Watch fixture (`fixtures/watch/snapshot-mixed-59d6895.json`: lifecycle
 * inferred, every other area observed) over the rib oracle briefing and releases. Extra provenance
 * replaces or adds entries by path.
 */
export function mixedSnapshot(mixed: string, extra: ViewSnapshot["provenance"] = []): ViewSnapshot {
  const snapshot = ViewSnapshotSchema.parse(JSON.parse(mixed));
  return ViewSnapshotSchema.parse({
    ...snapshot,
    provenance: [
      ...snapshot.provenance.filter(({ path }) => !extra.some((entry) => entry.path === path)),
      ...extra,
    ],
  });
}
