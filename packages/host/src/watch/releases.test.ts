// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectReleases } from "./releases.js";
import { fixtureInput, fixtureRoot } from "./snapshot-fixture.js";

process.env.TZ = "UTC";

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("read-only release notes", () => {
  it("projects missing, invalid and ok notes into distinct Releases states without writing", () => {
    const appData = mkdtempSync(join(tmpdir(), "spi-watch-notes-"));
    temporary.push(appData);
    const input = fixtureInput();
    const project = () =>
      projectReleases(input.releases, appData, input.context.clock.now(), input.context);
    expect(project().documents[0]?.notes).toBe("none");
    mkdirSync(join(appData, "notes"));
    const path = join(appData, "notes", "2026-10.json");
    writeFileSync(path, "headline: [");
    expect(project().documents[0]).toMatchObject({
      notes: "invalid",
      notesError: expect.any(String),
    });
    const raw = readFileSync(join(fixtureRoot, "notes/2026-10.json"), "utf8");
    writeFileSync(path, raw);
    expect(project().pane.lines[0]).toMatchObject({
      notes: "approved",
      headline: "All 13 services <now> ship from SPI forks.",
    });
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("surfaces non-ENOENT file errors instead of claiming notes are missing", () => {
    const appData = mkdtempSync(join(tmpdir(), "spi-watch-error-"));
    temporary.push(appData);
    mkdirSync(join(appData, "notes", "2026-10.json"), { recursive: true });
    const input = fixtureInput();
    expect(() =>
      projectReleases(input.releases, appData, input.context.clock.now(), input.context),
    ).toThrow();
  });

  it("does not cap the release months silently", () => {
    const input = fixtureInput();
    input.releases.releases.extra = Array.from({ length: 15 }, (_, i) => ({
      tag: `v${i}`,
      at: new Date(Date.UTC(2024, i, 1)).toISOString(),
      body: "",
    }));
    expect(
      projectReleases(input.releases, input.appData, input.context.clock.now(), input.context).pane
        .lines.length,
    ).toBeGreaterThan(12);
  });
});
