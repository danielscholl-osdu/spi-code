// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import {
  type InspectResult,
  InspectResultSchema,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";

/** The fixtures/watch snapshots the window text rules walk, one text-rules.<stem>.test.tsx each. */
export const WATCH_SNAPSHOTS = [
  "snapshot-1106-acknowledged.json",
  "snapshot-1106-unread.json",
  "snapshot-1106-unverified.json",
  "snapshot-1106.json",
  "snapshot-59d6895.json",
  "snapshot-bad.json",
  "snapshot-busy.json",
  "snapshot-calm.json",
  "snapshot-mixed-59d6895.json",
] as const;

/** Snapshots in fixtures/watch the text rules leave out, each with its reason. */
export const EXCLUDED_SNAPSHOTS: Record<string, string> = {};

export const WATCH_INSPECTIONS = ["inspect-1106.json", "inspect-stations-legal-59d6895.json"];

/** A repository-relative file reader; window helpers may not import node, so tests pass one. */
export type Read = (path: string) => string;

const directory = "fixtures/watch/";

export function watchSnapshot(name: string, read: Read): { name: string; body: ViewSnapshot } {
  if (!(WATCH_SNAPSHOTS as readonly string[]).includes(name))
    throw new Error(`${name} is not in WATCH_SNAPSHOTS`);
  return {
    name,
    body: ViewSnapshotSchema.parse(JSON.parse(read(`${directory}${name}`))),
  };
}

export const watchInspections = (read: Read): InspectResult[] =>
  WATCH_INSPECTIONS.flatMap((file) =>
    InspectResultSchema.array().parse(JSON.parse(read(`${directory}${file}`))),
  );

/** Snapshot and inspection files in a fixtures/watch listing that no list names. */
export function unlisted(files: readonly string[]): string[] {
  const named = new Set<string>([
    ...WATCH_SNAPSHOTS,
    ...Object.keys(EXCLUDED_SNAPSHOTS),
    ...WATCH_INSPECTIONS,
  ]);
  return files.filter((file) => /^(snapshot|inspect)-.*\.json$/.test(file) && !named.has(file));
}

export const textRulesFile = (snapshot: string) =>
  `text-rules.${snapshot.replace(/^snapshot-/, "").replace(/\.json$/, "")}.test.tsx`;
