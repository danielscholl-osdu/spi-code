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

/** The listed fixtures committed in fixtures/watch; scripts/watch-generated.mjs writes the rest. */
export const COMMITTED_FIXTURES = [
  "inspect-1106.json",
  "inspect-stations-legal-59d6895.json",
  "snapshot-1106.json",
];

export const watchFixturePath = (name: string) =>
  COMMITTED_FIXTURES.includes(name) ? `fixtures/watch/${name}` : `fixtures/watch/generated/${name}`;

/** A listed fixture's text, naming the generator when a generated one cannot be read. */
export function watchFixtureText(name: string, read: Read): string {
  const path = watchFixturePath(name);
  try {
    return read(path);
  } catch (error) {
    if (COMMITTED_FIXTURES.includes(name)) throw error;
    throw new Error(
      `Cannot read ${path}, which pnpm build && node scripts/watch-generated.mjs writes: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
}

export function watchSnapshot(name: string, read: Read): { name: string; body: ViewSnapshot } {
  if (!(WATCH_SNAPSHOTS as readonly string[]).includes(name))
    throw new Error(`${name} is not in WATCH_SNAPSHOTS`);
  return {
    name,
    body: ViewSnapshotSchema.parse(JSON.parse(watchFixtureText(name, read))),
  };
}

export const watchInspections = (read: Read): InspectResult[] =>
  WATCH_INSPECTIONS.flatMap((file) =>
    InspectResultSchema.array().parse(JSON.parse(watchFixtureText(file, read))),
  );

/** Snapshot and inspection files in a fixtures/watch listing, generated ones included, that no list names. */
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
