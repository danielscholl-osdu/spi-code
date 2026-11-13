// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AREAS, ViewSnapshotSchema } from "@spi-code/contracts";
import { createLeaseStore, createSnapshotStore, openRunStore } from "@spi-code/host";

const fleet = "Azure/osdu-spi-stack";
// The service names the smoke pins, so the shell sidebar shows each snapshot on every route.
export const initialSmoke = {
  headline: "Persisted Watch smoke snapshot",
  service: "smoke-persisted",
};
export const resumedSmoke = { headline: "Resumed Watch smoke snapshot", service: "smoke-resumed" };
export type SmokeMark = typeof initialSmoke;

export function writeSmokeSnapshot(path: string, { headline, service }: SmokeMark): number {
  openRunStore(path).close();
  const db = new DatabaseSync(path);
  try {
    const now = Date.now();
    const sweptAt = new Date(now).toISOString();
    const lease = createLeaseStore(db);
    const fence = lease.acquire(fleet, "smoke", 60000, now);
    assert(fence !== undefined);
    const view = ViewSnapshotSchema.parse({
      cursor: 0,
      sweptAt,
      campaigns: [],
      readings: [],
      seen: { cursor: null, since: [] },
      briefing: {
        sweptAt,
        nextSyncAt: sweptAt,
        doctor: { state: "clear", problems: [] },
        headline,
        summary: "Fixture only; no forge commands or sweep.",
        facts: [],
        focus: [],
        more: 0,
        rest: [],
        ready: [],
        themes: [],
        horizon: { headline: "" },
        flow: {
          mode: "quiet",
          headline: "",
          sub: "",
          tiles: [],
          rows: [],
          plan: { title: "", lines: [], note: "", button: "" },
          next: { title: "", text: "", button: "", quiet: true },
          also: [],
          inspect: "",
        },
        environment: { headline: "", facts: [], lanes: [], from: sweptAt, to: sweptAt },
        repositories: { headline: "", facts: [], rows: [] },
      },
      releases: { lines: [], reading: false },
      stations: [],
      tree: [{ id: `service:${service}`, status: "unread" }],
      reads: [],
      areas: AREAS.map((area) => ({ area, envelope: { source: area, state: "unread" } })),
      provenance: [],
      selection: null,
    });
    const cursor = createSnapshotStore(db).writeSnapshot(
      { fleet, owner: "smoke", fence },
      {},
      view,
      now,
    );
    assert(lease.release(fleet, "smoke", fence));
    return cursor;
  } finally {
    db.close();
  }
}

export function smokeSnapshotCursors(path: string): number[] {
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    return createSnapshotStore(db)
      .snapshotsSince(0)
      .map(({ cursor }) => cursor);
  } finally {
    db.close();
  }
}
