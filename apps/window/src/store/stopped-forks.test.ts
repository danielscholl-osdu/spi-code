// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import { expect, test } from "vitest";
import { selectStrip } from "./strip.js";

test.each([
  "snapshot-59d6895.json",
  "snapshot-mixed-59d6895.json",
  "snapshot-1106.json",
  "snapshot-1106-unread.json",
  "snapshot-1106-unverified.json",
])("%s gives Today and the strip the same stopped forks", (file) => {
  const snapshot = ViewSnapshotSchema.parse(
    JSON.parse(readFileSync(`fixtures/watch/${file}`, "utf8")),
  );
  const { stopped, pips } = selectStrip(snapshot);
  const tile = snapshot.briefing.facts.find(({ label }) => label === "Upstream sync");
  expect(tile?.figure).toBe(`${stopped.length} of ${pips.length}`);
  expect(tile?.tone).toBe(stopped.length > 0 ? "bad" : "ok");
  for (const service of stopped) expect(tile?.sub).toContain(service);
  expect(tile?.sub.includes("every sync flowing")).toBe(stopped.length === 0);
});
