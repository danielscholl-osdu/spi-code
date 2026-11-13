// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { watchFixtures } from "../../../../scripts/watch-generated.mjs";
import { directoryPaths } from "./directory-paths.test.js";
import {
  EXCLUDED_SNAPSHOTS,
  textRulesFile,
  unlisted,
  WATCH_INSPECTIONS,
  WATCH_SNAPSHOTS,
  watchFixturePath,
} from "./watch-fixtures.test-helper.js";

const fixtures = watchFixtures().map(({ name }) => name);

it("names every fixtures/watch snapshot and inspection as covered or excluded", () => {
  expect(unlisted(fixtures)).toEqual([]);
});

it("reports an unlisted snapshot by name", () => {
  expect(unlisted([...WATCH_SNAPSHOTS, "snapshot-x.json", "notes.md"])).toEqual([
    "snapshot-x.json",
  ]);
});

it("lists only fixtures that exist where the harness reads them, each covered or excluded but not both", () => {
  for (const name of [
    ...WATCH_SNAPSHOTS,
    ...Object.keys(EXCLUDED_SNAPSHOTS),
    ...WATCH_INSPECTIONS,
  ]) {
    expect(fixtures, name).toContain(name);
    expect(existsSync(watchFixturePath(name)), name).toBe(true);
  }
  for (const [name, reason] of Object.entries(EXCLUDED_SNAPSHOTS)) {
    expect(WATCH_SNAPSHOTS, name).not.toContain(name);
    expect(reason.trim(), name).not.toBe("");
  }
});

it("walks each covered snapshot in its own text-rules file", () => {
  const files = directoryPaths(resolve("apps/window/src/app")).filter((file) =>
    /^text-rules\.[^/]+\.test\.tsx$/.test(file),
  );
  expect(files).toEqual(WATCH_SNAPSHOTS.map(textRulesFile).sort());
});
