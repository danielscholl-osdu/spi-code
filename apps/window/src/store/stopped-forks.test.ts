// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { ViewSnapshotSchema } from "@spi-code/contracts";
import { expect, test } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { watchFixtureText } from "../test-utils/watch-fixtures.test-helper.js";
import { selectStrip } from "./strip.js";

test.each([
  "snapshot-59d6895.json",
  "snapshot-mixed-59d6895.json",
  "snapshot-1106.json",
  "snapshot-1106-unread.json",
  "snapshot-1106-unverified.json",
])("%s gives Today and the strip the same stopped forks", (file) => {
  const snapshot = ViewSnapshotSchema.parse(JSON.parse(watchFixtureText(file, readFixture)));
  const { stopped, pips } = selectStrip(snapshot);
  const tile = snapshot.briefing.facts.find(({ label }) => label === "Upstream sync");
  expect(tile?.figure).toBe(`${stopped.length} of ${pips.length}`);
  expect(tile?.tone).toBe(stopped.length > 0 ? "bad" : "ok");
  for (const service of stopped) expect(tile?.sub).toContain(service);
  expect(tile?.sub.includes("every sync flowing")).toBe(stopped.length === 0);
});

test.each([
  "snapshot-calm.json",
  "snapshot-busy.json",
  "snapshot-bad.json",
  "snapshot-59d6895.json",
  "snapshot-mixed-59d6895.json",
  "snapshot-1106.json",
  "snapshot-1106-unread.json",
  "snapshot-1106-unverified.json",
])("%s gives the verdict and the strip the same stopped count", (file) => {
  const snapshot = ViewSnapshotSchema.parse(JSON.parse(watchFixtureText(file, readFixture)));
  const { stopped, pips } = selectStrip(snapshot);
  const text = snapshot.briefing.verdict?.text ?? "";
  const named = /\b(\d+) forks? (?:is|are) stopped\b/.exec(text)?.[1];
  if (stopped.length === 0) {
    expect(named).toBeUndefined();
    expect(text).not.toBe("");
    if (snapshot.briefing.verdict?.mark === "nothing-due")
      expect(text).toContain(`all ${pips.length} forks are flowing`);
  } else {
    expect(Number(named)).toBe(stopped.length);
    expect(snapshot.briefing.verdict?.mark).toBe("stopped");
  }
});
