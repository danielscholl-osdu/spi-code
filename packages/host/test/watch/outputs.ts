// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { projectWatch } from "../../src/watch/project.js";
import { detailFeed, recordedDetailAnswers } from "./detail-feed.js";
import {
  acknowledgedInput,
  acknowledgedSnapshotPath,
  appStyle,
  badInput,
  badSnapshotPath,
  busyInput,
  busySnapshotPath,
  calmInput,
  calmSnapshotPath,
  detailFeedPath,
  fixtureInput,
  mixedFixtureInput,
  mixedSnapshotPath,
  recordedInput,
  recordedSnapshotPath,
  snapshotPath,
  unreadForksInput,
  unreadSnapshotPath,
  unverifiedForkInput,
  unverifiedSnapshotPath,
} from "./snapshot-fixture.js";

export interface WatchOutput {
  /** Repository-relative, with forward slashes. */
  readonly path: string;
  readonly value: () => unknown;
}

const repository = fileURLToPath(new URL("../../../../", import.meta.url));

const output = (path: string, value: () => unknown): WatchOutput => ({
  path: relative(repository, path).split(sep).join("/"),
  value,
});

/** Every file scripts/watch-snapshot.mjs writes; scripts/land lets exactly these land unreviewed. */
export const watchOutputs: readonly WatchOutput[] = [
  output(calmSnapshotPath, () => projectWatch(appStyle(calmInput()))),
  output(busySnapshotPath, () => projectWatch(appStyle(busyInput()))),
  output(badSnapshotPath, () => projectWatch(appStyle(badInput()))),
  output(snapshotPath, () => projectWatch(appStyle(fixtureInput()))),
  output(mixedSnapshotPath, () => projectWatch(appStyle(mixedFixtureInput()))),
  output(recordedSnapshotPath, () => projectWatch(appStyle(recordedInput()))),
  output(acknowledgedSnapshotPath, () => projectWatch(appStyle(acknowledgedInput()))),
  output(unreadSnapshotPath, () => projectWatch(appStyle(unreadForksInput()))),
  output(unverifiedSnapshotPath, () => projectWatch(appStyle(unverifiedForkInput()))),
  output(detailFeedPath, async () =>
    detailFeed(projectWatch(appStyle(recordedInput())).briefing, await recordedDetailAnswers()),
  ),
];
