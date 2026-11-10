// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type InspectResult,
  InspectResultSchema,
  type Message,
  PROTOCOL_VERSION,
  parseMessage,
  type ViewSnapshot,
} from "@spi-code/contracts";
import { type Exec, emptyCache } from "@spi-code/core";
import { attachHostPort, type HostPort } from "../process/port.js";
import { WatchRoutes, watchFleet } from "../process/routes.js";
import { createLeaseStore } from "../store/leases.js";
import { createSnapshotStore } from "../store/snapshots.js";
import { openRunStore } from "../store/store.js";
import { projectWatch } from "./project.js";
import { detailFeedPath, recordedInput } from "./snapshot-fixture.js";

type Briefing = ViewSnapshot["briefing"];

/** The hold events on the Environment lanes, with the id their Detail is requested by. */
export function briefingHolds(briefing: Briefing) {
  return briefing.environment.lanes
    .filter((lane) => lane.id === "holds")
    .flatMap((lane) => lane.events)
    .map((event) => ({ event, id: event.inspect ?? `hold:${event.id}` }));
}

/** The ids, in order, whose answers make up fixtures/watch/inspect-1106.json. */
export function detailFeedIds(briefing: Briefing): string[] {
  return [
    ...[...briefing.focus, ...briefing.rest].map(({ id }) => id),
    ...briefing.themes.map((theme) => `theme:${theme.id}`),
    ...briefingHolds(briefing).map(({ id }) => id),
  ];
}

const offline: Exec = {
  runJSON: async () => ({ ok: false, error: "offline", code: 1 }),
  runText: async () => ({ ok: false, error: "offline", code: 1 }),
};

/**
 * Persists the recorded 6 Nov sweep to a scratch store and asks the offline router's
 * inspect.request for every queue item, theme and hold, as the window's Detail does.
 */
export async function recordedDetailAnswers(): Promise<Map<string, InspectResult>> {
  const input = recordedInput();
  const { cursor: _, ...projected } = projectWatch(input);
  const { briefing } = projected;
  const ctx = input.context;
  const fleet = watchFleet(ctx);
  const now = ctx.clock.now().getTime();
  const directory = mkdtempSync(join(tmpdir(), "spi-parity-"));
  const path = join(directory, "store.sqlite");
  let db: DatabaseSync | undefined;
  try {
    openRunStore(path).close();
    db = new DatabaseSync(path);
    const fence = createLeaseStore(db).acquire(fleet, "sweeper", 60_000, now);
    if (fence === undefined) throw new Error("lease not acquired");
    createSnapshotStore(db).writeSnapshot(
      { fleet, owner: "sweeper", fence },
      {
        facts: input.facts,
        cache: { ...emptyCache(), releases: { ...input.releases, records: input.releaseRecords } },
        reads: {},
      },
      projected,
      now,
    );
    db.close();
    const served = new DatabaseSync(path);
    db = served;

    const sent: Message[] = [];
    let receive: (event: { data: unknown }) => void = () => {
      throw new Error("Port not attached");
    };
    const port: HostPort = {
      on(_event, listener) {
        receive = listener;
      },
      postMessage(message) {
        const parsed = parseMessage(message);
        if (!parsed.ok) throw new Error("host posted an invalid message");
        sent.push(parsed.message);
      },
      start() {},
    };
    const routes = new WatchRoutes({
      db: () => served,
      fleet,
      ctx,
      appData: input.appData,
      exec: offline,
      onError: (error) => {
        throw error;
      },
    });
    attachHostPort(port, 1, undefined, undefined, routes.routes);
    const ids = [
      ...[...briefing.focus, ...briefing.rest].map(({ id }) => id),
      ...briefing.themes.map((theme) => `theme:${theme.id}`),
      ...briefingHolds(briefing).map(({ id }) => id),
    ];
    for (const id of new Set(ids))
      receive({
        data: {
          version: PROTOCOL_VERSION,
          id,
          kind: "request",
          type: "inspect.request",
          payload: { id },
        },
      });
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    const results = new Map<string, InspectResult>();
    for (const message of sent)
      if (message.type === "inspect.result")
        results.set(message.id, InspectResultSchema.parse(message.payload));
    return results;
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The answers the window's reachability suite draws Detail from, in detailFeedIds order. */
export function detailFeed(briefing: Briefing, answers: Map<string, InspectResult>) {
  return detailFeedIds(briefing).map((id) => {
    const result = answers.get(id);
    if (!result) throw new Error(`No inspect.result for ${id}`);
    return result;
  });
}

/** Regenerates fixtures/watch/inspect-1106.json; scripts/watch-snapshot.ts runs it under Node. */
export async function writeDetailFeed(path = detailFeedPath): Promise<void> {
  const { briefing } = projectWatch(recordedInput());
  const feed = detailFeed(briefing, await recordedDetailAnswers());
  writeFileSync(path, `${JSON.stringify(feed, null, 2)}\n`);
}
