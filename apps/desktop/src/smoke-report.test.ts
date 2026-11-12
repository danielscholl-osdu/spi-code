// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { APPENDIX_A_TOOLS } from "../../../packages/host/src/tools/tool-names.js";
import type { SmokeGeometry } from "./smoke-geometry.js";
import {
  MORNING_FIXTURES,
  MORNING_SURFACES,
  type MorningEvidence,
  type MorningSurface,
  morningSections,
} from "./smoke-mornings.js";
import {
  assertSmokeReport,
  assertSmokeShot,
  assertSmokeViews,
  geometryRules,
  type SmokeReport,
  VIEW_SURFACES,
  VIEW_WIDTHS,
} from "./smoke-report.js";
import { smokeScheduledSweep, smokeSweepProgress } from "./smoke-sweep.js";

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const firstSweepQualifiers: Record<string, string[]> = {
  "first-sweep-running": [
    "First sweep · 9 of 12 sources done",
    "First sweep is reading the program. 6 run lists cut short; rest read. 3 reads failed. Reads failed for 3 services: unit, crs-catalog, crs-conversion. waits for GitHub budget · after 09:10. glab is not signed in. Open Settings",
  ],
  "first-sweep-throttled": [
    "First sweep · 9 of 12 sources done",
    "GitHub asked SPI Code to slow down. Resumes at 09:10.",
  ],
  "first-sweep-stopped": [
    "first sweep stopped",
    "The first sweep stopped. It stopped while reading Workflow runs: GitHub did not answer in time. SPI Code tries again at 09:07. Try again",
  ],
  "first-sweep-stopped-saving": [
    "first sweep stopped",
    "The first sweep stopped. It stopped while saving: The disk is full. Try again",
  ],
  "first-sweep-place": [
    "First sweep · 9 of 12 sources done",
    "Upstream opens after the first sweep. It is read 9th of 12.",
  ],
  "first-sweep-evidence": [
    "swept 08:02 · 1 failed",
    "The sweep Sources 6 run lists cut short; rest read. 3 reads failed. Reads failed for 3 services: unit, crs-catalog, crs-conversion. waits for GitHub budget · after 09:10. glab is not signed in. Open Settings",
  ],
  "first-sweep-refresh": ["Swept 08:02 · sweeping, 4 of 12 sources done", "GitLab reads failed."],
};
const scheduledQualifiers: Record<string, string[]> = {
  "settings-sweep-idle": [
    "Swept 08:02",
    "Schedule Last sweep Next sweep 08:07 (in 3 min) What a sweep reads GitHub budget 4,865 points left · resets 09:36 Notifications Sweep now",
  ],
  "settings-sweep-sweeping": [
    "Swept 08:02 · sweeping, 4 of 12 sources done",
    "Schedule Last sweep What a sweep reads GitHub budget Notifications Sweeping · 4 of 12 View live sweep →",
  ],
  "settings-sweep-saved-failure": [
    "Swept 09:04",
    "Schedule Last sweep Next sweep 09:09 What a sweep reads GitHub budget Notifications Sweep now Sweep saved at 09:04 · 1 source failed. View sweep →",
  ],
  "settings-sweep-not-ready": [
    "Swept 08:02",
    "Schedule Last sweep Next sweep 08:07 What a sweep reads GitHub budget Notifications Sweep now Watch is not ready. Open Readiness.",
  ],
  "evidence-header-idle": ["Swept 08:02", "Swept 08:02 · next sweep 08:07 Sweep now"],
  "evidence-header-sweeping": [
    "Swept 08:02 · sweeping, 4 of 12 sources done",
    "Sweeping since 08:07 · 4 of 12 Sweeping · 4 of 12 View live sweep →",
  ],
};

it("pins scheduled fixtures before their promises and commits exactly one failed source", () => {
  const snapshot = ViewSnapshotSchema.parse(
    JSON.parse(
      readFileSync(new URL("../../../fixtures/watch/snapshot-1106.json", import.meta.url), "utf8"),
    ),
  );
  for (const state of ["idle", "sweeping", "saved-failure", "not-ready"] as const) {
    const fixture = smokeScheduledSweep(snapshot, state);
    expect(Date.parse(fixture.status.resetAt ?? "")).toBeGreaterThan(fixture.now);
    if (fixture.status.nextSweepAt)
      expect(Date.parse(fixture.status.nextSweepAt)).toBeGreaterThan(fixture.now);
    expect(fixture.progress.sources).toHaveLength(12);
    expect(fixture.progress.sources.filter(({ state }) => state === "read")).toHaveLength(
      state === "sweeping" ? 4 : state === "saved-failure" ? 11 : 10,
    );
    if (state === "saved-failure") {
      expect(fixture.progress.sources.filter(({ state }) => state === "failed")).toHaveLength(1);
      expect(Date.parse(fixture.snapshot.sweptAt)).toBeGreaterThanOrEqual(
        Date.parse(fixture.progress.startedAt),
      );
      expect(fixture.status.lastSweep?.requested).toBe(true);
    }
  }
});

it.each(["idle", "sweeping", "saved-failure", "not-ready"] as const)(
  "keeps progress, committed areas, read records and provenance consistent in %s",
  (state) => {
    const snapshot = ViewSnapshotSchema.parse(
      JSON.parse(
        readFileSync(
          new URL("../../../fixtures/watch/snapshot-1106.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const fixture = smokeScheduledSweep(snapshot, state);
    const completed =
      fixture.progress.outcome === "committed" ? fixture.progress : fixture.completed;
    expect(completed.outcome).toBe("committed");
    expect(fixture.status.lastSweep).toMatchObject({
      sweep: completed.sweep,
      startedAt: completed.startedAt,
      endedAt: fixture.snapshot.sweptAt,
    });
    const envelopes = [
      ...fixture.snapshot.areas.map(({ envelope }) => envelope),
      ...fixture.snapshot.provenance.flatMap(({ envelope }) => (envelope ? [envelope] : [])),
    ];
    expect([...new Set(envelopes.map(({ source }) => source))].sort()).toEqual(
      completed.sources.map(({ source }) => source).sort(),
    );
    expect(fixture.snapshot.reads).toHaveLength(completed.sources.length);
    for (const source of completed.sources) {
      const observed = envelopes.filter(({ source: name }) => name === source.source);
      expect(observed.length, source.source).toBeGreaterThan(0);
      const record = fixture.snapshot.reads.find(({ source: name }) => name === source.source);
      expect(record, source.source).toBeDefined();
      for (const envelope of observed) {
        expect(envelope.state, source.source).toBe(source.state === "failed" ? "failed" : "fresh");
        if (envelope.state === "unread") throw new Error(`Missing read: ${source.source}`);
        if (source.state === "read") {
          expect(envelope.observedAt, source.source).toBe(source.endedAt);
          expect(record?.observedAt).toBe(source.endedAt);
          expect(record?.failure).toBeUndefined();
        } else {
          expect(source.state).toMatch(/failed|skipped/);
          expect(Date.parse(envelope.observedAt ?? "")).toBeLessThan(
            Date.parse(completed.startedAt),
          );
          if (source.state === "failed") {
            expect(record?.observedAt).toBe(source.endedAt);
            expect(record?.failure).toBe(source.reason);
            expect(record?.retainedFrom).toBe(envelope.observedAt);
          } else {
            expect(record?.observedAt).toBe(envelope.observedAt);
            expect(record?.failure).toBeUndefined();
          }
        }
      }
    }
    const failed = completed.sources.filter(({ state }) => state === "failed");
    expect(failed).toHaveLength(1);
    expect(
      fixture.snapshot.areas
        .filter(({ envelope }) => envelope.state === "failed")
        .map(({ area }) => area),
    ).toEqual(failed.map(({ source }) => source));
    if (state === "sweeping") {
      expect(fixture.progress.outcome).toBe("running");
      expect(Date.parse(fixture.snapshot.sweptAt)).toBeLessThan(
        Date.parse(fixture.progress.startedAt),
      );
      for (const source of fixture.progress.sources) {
        if (source.state !== "read") continue;
        expect(Date.parse(source.endedAt ?? "")).toBeGreaterThan(
          Date.parse(fixture.snapshot.sweptAt),
        );
        expect(
          fixture.snapshot.areas.find(({ area }) => area === source.source)?.envelope,
        ).not.toMatchObject({
          observedAt: source.endedAt,
        });
      }
    } else {
      expect(fixture.completed).toEqual(fixture.progress);
    }
    expect(snapshot.sweptAt).toBe("2026-11-06T14:02:00.133Z");
  },
);

it("keeps the retained first-sweep failure line consistent with the snapshot's failed services", () => {
  const snapshot = ViewSnapshotSchema.parse(
    JSON.parse(
      readFileSync(new URL("../../../fixtures/watch/snapshot-1106.json", import.meta.url), "utf8"),
    ),
  );
  const services = [
    ...new Set(
      snapshot.reads
        .filter((record) => record.failure !== undefined)
        .map(({ source }) => (source.split("/").at(-1) ?? source).replace(/^osdu-spi-/, "")),
    ),
  ];
  expect(
    smokeSweepProgress().committed.sources.find(({ source }) => source === "template"),
  ).toMatchObject({
    state: "cut",
    incomplete: { failed: services.length },
    failure: `Reads failed for ${services.length} services: ${services.join(", ")}.`,
  });
});

function geometry(surface: string, width: number): SmokeGeometry[] {
  return geometryRules(surface, width).map((rule) => {
    switch (rule) {
      case "sweep-visible":
        return {
          rule,
          viewport: rect(0, 0, width, 800),
          panel: rect(24, 120, width - 48, 560),
          elements: [rect(42, 130, 300, 44), rect(42, 190, 300, 44), rect(400, 130, 200, 30)],
        };
      case "sweep-reads":
        return {
          rule,
          width,
          picker: width === 740 ? "Sweep" : null,
          rows: Array.from({ length: 4 }, (_, index) => ({
            name: rect(42, 300 + index * 64, 300, 24),
            cadence: rect(42, 328 + index * 64, 120, 18),
            lastRead: rect(580, 328 + index * 64, 118, 18),
            label: width === 740 ? "last read" : "",
          })),
        };
      case "window":
        return {
          rule,
          viewport: rect(0, 0, width, 800),
          scroll: { width, height: 800 },
          panes: [rect(0, 75, width, 725)],
        };
      case "settings":
        return {
          rule,
          viewport: rect(0, 0, width, 800),
          dialog: rect(
            (width - Math.min(820, width - 48)) / 2,
            120,
            Math.min(820, width - 48),
            560,
          ),
        };
      case "overlay-drag": {
        const settings = surface.startsWith("settings-sweep-");
        const backdrop = settings || width < 1440 ? rect(0, 0, width, 800) : undefined;
        return {
          rule,
          overlay: settings ? "[role=dialog].settings" : ".right-panel-frame",
          viewport: rect(0, 0, width, 800),
          regions: [
            { appRegion: "drag", rect: rect(0, 0, width, 44) },
            { appRegion: "no-drag", rect: rect(24, 120, width - 48, 560) },
            ...(backdrop ? [{ appRegion: "no-drag" as const, rect: backdrop }] : []),
          ],
          targets: [{ label: "Sweep now", rect: rect(width - 240, 130, 180, 30) }],
          ...(backdrop ? { backdrop } : {}),
        };
      }
      case "related":
        return {
          rule,
          panel: rect(1160, 75, 280, 725),
          label: rect(1184, 300, 232, 54),
          labelText: "A deliberately long Related label that wraps over multiple lines at 280 px",
          values: [rect(1184, 356, 232, 42)],
        };
      case "panes":
        return {
          rule,
          viewport: rect(0, 0, width, 800),
          scroll: { width, height: 800 },
          panes: [232, 568, 360, 280].map((size, index, sizes) => ({
            rect: rect(
              sizes.slice(0, index).reduce((a, b) => a + b, 0),
              75,
              size,
              725,
            ),
            borderLeft: index > 1 ? 1 : 0,
            borderRight: index === 0 ? 1 : 0,
          })),
        };
      case "headers":
        return {
          rule,
          paneTop: 75,
          panes: [rect(232, 75, 568, 725), rect(800, 75, 360, 725), rect(1160, 75, 280, 725)],
          headers: [rect(232, 75, 568, 44), rect(800, 75, 360, 44), rect(1160, 75, 280, 44)],
        };
      case "failed-reads":
        return {
          rule,
          section: rect(width - 360, 650, 360, 52),
          panel: rect(width - 360, 88, 360, 712),
          rows: [
            {
              source: "GitHub issues and PRs",
              outcome: "read failed · unit, crs-catalog, crs-conversion",
            },
          ],
        };
      case "drag":
        return {
          rule,
          services: 20,
          appRegion: "drag",
          region: rect(84, 0, 648, 44),
          targets: [rect(84, 0, 500, 44), rect(632, 0, 100, 44)],
        };
    }
    throw new Error(`Unknown geometry rule: ${rule}`);
  });
}

const morningBlocks: Record<MorningSurface["morning"], MorningEvidence["blocks"]> = {
  calm: [
    { name: "head", top: 108, height: 77 },
    { name: "horizon", top: 201, height: 247 },
    { name: "places", top: 470, height: 221 },
    { name: "releases", top: 712, height: 196 },
    { name: "motion", top: 712, height: 122 },
  ],
  busy: [
    { name: "head", top: 108, height: 77 },
    { name: "band", top: 201, height: 369 },
    { name: "horizon", top: 592, height: 374 },
    { name: "places", top: 988, height: 221 },
    { name: "releases", top: 1230, height: 271 },
  ],
  bad: [
    { name: "head", top: 108, height: 77 },
    { name: "caveat", top: 201, height: 35 },
    { name: "band", top: 254, height: 396 },
    { name: "horizon", top: 672, height: 478 },
    { name: "places", top: 1171, height: 293 },
    { name: "releases", top: 1486, height: 196 },
  ],
};

function morningShot(
  surface: MorningSurface,
  viewportWidth: number,
  appearance: "light" | "dark",
): SmokeReport["views"][number] {
  const pageHeight = 1702;
  return {
    surface: surface.id,
    appearance,
    viewportWidth,
    file: `views/${surface.id}-${viewportWidth}-${appearance}.png`,
    width: viewportWidth * 2,
    height: pageHeight * 2,
    bytes: 200000,
    dominantFraction: 0.6,
    qualifiers: [
      "Swept 08:02",
      surface.morning === "bad"
        ? "GitHub issues and PRs read failed at 08:02; items from it may be missing. Evidence ›"
        : "",
    ],
    geometry: [
      ...geometry("today", viewportWidth),
      { rule: "release-platform", platform: rect(24, 1000, 676, 40), versions: 0, library: null },
    ],
    morning: {
      morning: surface.morning,
      fixture: MORNING_FIXTURES[surface.morning],
      detail: surface.detail,
      sections: morningSections(surface.morning, surface.detail, viewportWidth),
      headline: {
        calm: "Nothing urgent needs you. v0.35.3 is deployable; all 13 forks are flowing.",
        busy: "1 thing needs you; 2 forks are stopped; 4 upstream changes need you before they land.",
        bad: "3 things need you; 4 forks are stopped. GitHub wasn't read this sweep.",
      }[surface.morning],
      viewportHeight: 800,
      scrollHeight: 1594,
      clientHeight: 692,
      pageHeight,
      blocks: morningBlocks[surface.morning],
      ...(surface.detail ? { detailTitle: "partition v1.3.3" } : {}),
    },
  };
}

const report: SmokeReport = {
  mainPid: 101,
  hostPid: 102,
  restartedHostPid: 103,
  rendererPids: [110],
  mainNodeVersion: "24.15.0",
  hostNodeVersion: "24.15.0",
  sqliteIsTransaction: true,
  tray: true,
  rendererRoundTrip: true,
  reloadRoundTrip: true,
  permissionDenied: true,
  permissionQueryDenied: true,
  malformed: "rejected",
  rowSurvived: true,
  listeners: [],
  tools: APPENDIX_A_TOOLS.map(({ name, tier }) => ({
    name,
    outcome: tier === "Read" ? "completed" : "refused",
  })),
  deniedBuiltIn: { name: "builtin:shell", outcome: "refused" },
  views: [
    ...VIEW_SURFACES.flatMap(({ id }) =>
      VIEW_WIDTHS.flatMap((viewportWidth) =>
        (["light", "dark"] as const).map((appearance) => ({
          surface: id,
          appearance,
          viewportWidth,
          file: `views/${id}-${viewportWidth}-${appearance}.png`,
          width: viewportWidth,
          height: 800,
          bytes: 20000,
          dominantFraction: 0.6,
          qualifiers: scheduledQualifiers[id] ??
            firstSweepQualifiers[id] ?? [
              "swept 08:02 · 1 failed",
              "GitLab reads failed; items may be missing.",
            ],
          geometry: geometry(id, viewportWidth),
          ...(id === "detail-related" && viewportWidth === 1440 && appearance === "light"
            ? { rejectedGeometry: "Related value squeezed to 159 px" }
            : {}),
        })),
      ),
    ),
    ...MORNING_SURFACES.flatMap((surface) =>
      surface.widths.flatMap((viewportWidth) =>
        (["light", "dark"] as const).map((appearance) =>
          morningShot(surface, viewportWidth, appearance),
        ),
      ),
    ),
  ],
  supervision: {
    signal: "SIGKILL",
    hostPids: [102, 103, 104, 105, 106, 107, 108, 109],
    channelTransfers: 9,
    fromCursor: 1,
    resumedCursor: 2,
    persistedCursors: [1, 2],
    sameRenderer: true,
    freshChannel: true,
    giveUpAcrossReload: true,
    reloadExactlyOnce: true,
    lateSubframeNoReconnect: true,
    canceledNavigationNoReconnect: true,
  },
};

it("accepts the terminal smoke report", () => {
  expect(() => assertSmokeReport(JSON.parse(JSON.stringify(report)))).not.toThrow();
});

it("accepts Sweep headings transformed to uppercase by the rendered stylesheet", () => {
  expect(() =>
    assertSmokeViews(
      report.views.map((shot) =>
        shot.surface.startsWith("settings-sweep-")
          ? {
              ...shot,
              qualifiers: shot.qualifiers.map((text) =>
                text.replace(
                  /Schedule|What a sweep reads|GitHub budget|Notifications/g,
                  (heading) => heading.toUpperCase(),
                ),
              ),
            }
          : shot,
      ),
    ),
  ).not.toThrow();
});

it.each([
  { hostPid: 101 },
  { restartedHostPid: 102 },
  { rendererPids: undefined },
  { rendererPids: [] },
  { rendererPids: [101] },
  { rendererPids: [-1] },
  { hostPid: -1 },
  { malformed: "accepted" },
  { rowSurvived: false },
  { listeners: ["TCP *:1234 (LISTEN)"] },
  { sqliteIsTransaction: false },
  { tray: false },
  { tray: undefined },
  { rendererRoundTrip: false },
  { reloadRoundTrip: false },
  { permissionDenied: false },
  { permissionQueryDenied: false },
  { hostNodeVersion: "22.15.0" },
  { mainNodeVersion: "invalid" },
  { tools: report.tools.slice(1) },
  { tools: [...report.tools, report.tools[0]] },
  { tools: report.tools.map((tool) => ({ ...tool, outcome: "completed" })) },
  { deniedBuiltIn: { name: "builtin:shell", outcome: "completed" } },
  { deniedBuiltIn: undefined },
  { supervision: undefined },
  { views: undefined },
])("rejects a failed smoke check: %j", (failure) => {
  expect(() => assertSmokeReport(JSON.parse(JSON.stringify({ ...report, ...failure })))).toThrow();
});

function syntheticImage(background: number, inkPixels: number) {
  const width = 640;
  const height = 400;
  const bitmap = Buffer.alloc(width * height * 4, background);
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    bitmap[offset + 3] = 255;
    if (offset / 4 < inkPixels) {
      bitmap[offset] = 255 - background;
      bitmap[offset + 1] = 255 - background;
      bitmap[offset + 2] = 255 - background;
    }
  }
  return { width, height, bitmap, bytes: 20000 };
}

const qualifiers = [
  "swept 08:02 · 1 failed",
  "GitLab reads failed; items may be missing.",
] as const;

it.each([24, 240])("accepts a synthetic populated light/dark image (%s)", (background) => {
  expect(assertSmokeShot("today", syntheticImage(background, 20000), qualifiers)).toMatchObject({
    width: 640,
    height: 400,
    dominantFraction: 236000 / 256000,
  });
});

it("fails on a missing shot, including a missing appearance or duplicate surface", () => {
  expect(() => assertSmokeShot("today", undefined, qualifiers)).toThrow("Missing screenshot");
  expect(() => assertSmokeViews(report.views.slice(1))).toThrow("Missing screenshot");
  const duplicate = [...report.views];
  const replacement = duplicate[1];
  if (!replacement) throw new Error("Missing populated screenshot fixture");
  duplicate[0] = { ...replacement };
  expect(() => assertSmokeViews(duplicate)).toThrow("Missing or duplicate screenshot");
});

it("rejects a missing dark appearance even when the screenshot count is unchanged", () => {
  const mutation = report.views.map((shot) =>
    shot.surface === "security" && shot.appearance === "dark"
      ? { ...shot, appearance: "system" }
      : shot,
  );
  expect(() => assertSmokeViews(mutation)).toThrow("security/1440/dark");
});

it.each(Object.keys(scheduledQualifiers))(
  "requires every scheduled capture and its visible state: %s",
  (surface) => {
    for (const width of VIEW_WIDTHS) {
      for (const appearance of ["light", "dark"]) {
        const matches = (shot: SmokeReport["views"][number]) =>
          shot.surface === surface &&
          shot.viewportWidth === width &&
          shot.appearance === appearance;
        expect(report.views.some(matches)).toBe(true);
        expect(() => assertSmokeViews(report.views.filter((shot) => !matches(shot)))).toThrow(
          "Missing screenshot",
        );
        for (const mutation of [
          { qualifiers: ["Swept 08:02", ""] },
          { geometry: geometry(surface, width).filter(({ rule }) => rule !== "sweep-visible") },
        ]) {
          expect(() =>
            assertSmokeViews(
              report.views.map((shot) => (matches(shot) ? { ...shot, ...mutation } : shot)),
            ),
          ).toThrow();
        }
      }
    }
  },
);

it.each([
  ["settings-sweep-idle", "Next sweep 08:07 (in 3 min)", "Next sweep 08:08 (in 3 min)"],
  ["settings-sweep-idle", "4,865 points left · resets 09:36", "4,864 points left · resets 09:36"],
  ["settings-sweep-idle", "Sweep now", "Sweep unavailable"],
  ["settings-sweep-sweeping", "Sweeping · 4 of 12", "Sweeping · 5 of 12"],
  ["settings-sweep-sweeping", "View live sweep →", "View sweep →"],
  ["settings-sweep-saved-failure", "1 source failed", "0 sources failed"],
  ["settings-sweep-saved-failure", "Next sweep 09:09", "Next sweep 09:08"],
  ["settings-sweep-saved-failure", "Sweep now", "Sweep unavailable"],
  ["settings-sweep-not-ready", "Watch is not ready.", "Watch is ready."],
  ["settings-sweep-not-ready", "Sweep now", "Sweep unavailable"],
  ["evidence-header-idle", "next sweep 08:07", "next sweep 08:08"],
  ["evidence-header-idle", "Sweep now", "Sweep unavailable"],
  ["evidence-header-sweeping", "Sweeping since 08:07", "Sweeping since 08:06"],
  ["evidence-header-sweeping", "Sweeping · 4 of 12", "Sweeping · 5 of 12"],
  ["evidence-header-sweeping", "View live sweep →", "View sweep →"],
])("requires the scheduled state text in %s: %s", (surface, before, after) => {
  expect(() =>
    assertSmokeViews(
      report.views.map((shot) =>
        shot.surface === surface
          ? {
              ...shot,
              qualifiers: [shot.qualifiers[0], shot.qualifiers[1]?.replace(before, after)],
            }
          : shot,
      ),
    ),
  ).toThrow("Missing state qualifier");
});

it.each(["Schedule", "Last sweep", "What a sweep reads", "GitHub budget", "Notifications"])(
  "requires the Sweep section text: %s",
  (heading) => {
    expect(() =>
      assertSmokeViews(
        report.views.map((shot) =>
          shot.surface.startsWith("settings-sweep-")
            ? {
                ...shot,
                qualifiers: [shot.qualifiers[0], shot.qualifiers[1]?.replace(heading, "Omitted")],
              }
            : shot,
        ),
      ),
    ).toThrow("Missing Sweep section qualifier");
  },
);

it.each(["picker", "cadence", "lastRead", "label"] as const)(
  "uses the shot's 740 px width for Sweep %s checks despite a different measured width",
  (field) => {
    expect(() =>
      assertSmokeViews(
        report.views.map((shot) =>
          shot.surface === "settings-sweep-idle" && shot.viewportWidth === 740
            ? {
                ...shot,
                geometry: shot.geometry.map((geometry) =>
                  geometry.rule === "sweep-reads"
                    ? {
                        ...geometry,
                        width: 900,
                        picker: field === "picker" ? "Readiness" : geometry.picker,
                        rows: geometry.rows.map((row) => ({
                          ...row,
                          ...(field === "cadence" || field === "lastRead"
                            ? { [field]: { ...row[field], y: row.name.y } }
                            : field === "label"
                              ? { label: "" }
                              : {}),
                        })),
                      }
                    : geometry,
                ),
              }
            : shot,
        ),
      ),
    ).toThrow(
      field === "picker"
        ? "Sweep picker"
        : field === "label"
          ? "Sweep last-read label"
          : "Sweep columns must fold",
    );
  },
);

it("rejects a measured Sweep width that differs from its shot with valid picker and folded rows", () => {
  expect(() =>
    assertSmokeViews(
      report.views.map((shot) =>
        shot.surface === "settings-sweep-idle" && shot.viewportWidth === 740
          ? {
              ...shot,
              geometry: shot.geometry.map((geometry) =>
                geometry.rule === "sweep-reads" ? { ...geometry, width: 900 } : geometry,
              ),
            }
          : shot,
      ),
    ),
  ).toThrow("Sweep measured width differs from shot");
});

it.each(Object.keys(scheduledQualifiers))(
  "requires overlay drag geometry on every scheduled capture: %s",
  (surface) => {
    for (const width of VIEW_WIDTHS) {
      for (const appearance of ["light", "dark"]) {
        expect(() =>
          assertSmokeViews(
            report.views.map((shot) =>
              shot.surface === surface &&
              shot.viewportWidth === width &&
              shot.appearance === appearance
                ? {
                    ...shot,
                    geometry: shot.geometry.filter(({ rule }) => rule !== "overlay-drag"),
                  }
                : shot,
            ),
          ),
        ).toThrow("Missing geometry rules");
      }
    }
  },
);

it.each(Object.keys(scheduledQualifiers).filter((surface) => surface.startsWith("settings-")))(
  "rejects a missing or draggable Sweep Settings backdrop: %s",
  (surface) => {
    for (const width of VIEW_WIDTHS) {
      for (const appearance of ["light", "dark"]) {
        for (const missing of [true, false]) {
          expect(() =>
            assertSmokeViews(
              report.views.map((shot) =>
                shot.surface === surface &&
                shot.viewportWidth === width &&
                shot.appearance === appearance
                  ? {
                      ...shot,
                      geometry: shot.geometry.map((geometry) =>
                        geometry.rule === "overlay-drag"
                          ? missing
                            ? { ...geometry, backdrop: undefined }
                            : {
                                ...geometry,
                                regions: geometry.regions.filter(
                                  ({ appRegion }) => appRegion === "drag",
                                ),
                              }
                          : geometry,
                      ),
                    }
                  : shot,
              ),
            ),
          ).toThrow(/backdrop/);
        }
      }
    }
  },
);

it("fails when a single surface/width/appearance combination is dropped or replaced", () => {
  const missing = report.views.filter(
    (shot) =>
      !(
        shot.surface === "settings-failed" &&
        shot.viewportWidth === 740 &&
        shot.appearance === "dark"
      ),
  );
  expect(() => assertSmokeViews(missing)).toThrow("Missing screenshot");
  const disguised = report.views.map((shot) =>
    shot.surface === "settings-failed" && shot.viewportWidth === 740 && shot.appearance === "dark"
      ? { ...shot, viewportWidth: 900 }
      : shot,
  );
  expect(() => assertSmokeViews(disguised)).toThrow(/settings-failed\/900\/dark/);
});

it.each(Object.keys(firstSweepQualifiers))(
  "requires every width and appearance and the state evidence for %s",
  (surface) => {
    for (const width of VIEW_WIDTHS) {
      for (const appearance of ["light", "dark"]) {
        const matches = (shot: SmokeReport["views"][number]) =>
          shot.surface === surface &&
          shot.viewportWidth === width &&
          shot.appearance === appearance;
        expect(report.views.some(matches)).toBe(true);
        expect(() => assertSmokeViews(report.views.filter((shot) => !matches(shot)))).toThrow(
          "Missing screenshot",
        );
        expect(() =>
          assertSmokeViews(
            report.views.map((shot) => (matches(shot) ? { ...shot, qualifiers: ["", ""] } : shot)),
          ),
        ).toThrow(/qualifier/);
        expect(() =>
          assertSmokeViews(
            report.views.map((shot) =>
              matches(shot) ? { ...shot, qualifiers: [shot.qualifiers[0], ""] } : shot,
            ),
          ),
        ).toThrow(/qualifier/);
        expect(() =>
          assertSmokeViews(
            report.views.map((shot) =>
              matches(shot)
                ? { ...shot, geometry: shot.geometry.filter((check) => check.rule !== "headers") }
                : shot,
            ),
          ),
        ).toThrow("Missing geometry rules");
      }
    }
  },
);

it.each(["first-sweep-stopped", "first-sweep-stopped-saving"])(
  "rejects stale stopped capture qualifiers: %s",
  (surface) => {
    const mutate = (qualifiers: (text: readonly string[]) => string[]) =>
      report.views.map((shot) =>
        shot.surface === surface ? { ...shot, qualifiers: qualifiers(shot.qualifiers) } : shot,
      );
    expect(() =>
      assertSmokeViews(mutate((text) => ["waiting for the first sweep", text[1] ?? ""])),
    ).toThrow("Missing stopped qualifier");
    if (surface === "first-sweep-stopped") {
      expect(() =>
        assertSmokeViews(mutate((text) => [text[0] ?? "", `${text[1]} Open Settings`])),
      ).toThrow("Unfixable stop offers Settings");
    }
  },
);

it.each([24, 240])("fails uniform and nearly one-colour images (%s)", (background) => {
  for (const inkPixels of [0, 1, 1280]) {
    expect(() =>
      assertSmokeShot("today", syntheticImage(background, inkPixels), qualifiers),
    ).toThrow("Blank screenshot");
  }
  expect(() =>
    assertSmokeShot("today", syntheticImage(background, 1281), qualifiers),
  ).not.toThrow();
});

it("fails missing or broken renderer geometry in the terminal report", () => {
  for (const geometry of [[], [{ rule: "drag", services: 13 }]]) {
    expect(() =>
      assertSmokeViews(
        report.views.map((shot) =>
          shot.surface === "strip-20" && shot.viewportWidth === 740 ? { ...shot, geometry } : shot,
        ),
      ),
    ).toThrow();
  }
  expect(() =>
    assertSmokeViews(
      report.views.map((shot) => ({
        ...shot,
        rejectedGeometry: undefined,
      })),
    ),
  ).toThrow("Missing packaged broken-rule proof");
  expect(() =>
    assertSmokeViews(
      report.views.map((shot) => ({
        ...shot,
        geometry: shot.geometry.map((check) =>
          shot.surface === "panes" && check.rule === "headers"
            ? { ...check, panes: check.panes.slice(0, 1), headers: check.headers.slice(0, 1) }
            : check,
        ),
      })),
    ),
  ).toThrow("Header probe requires centre, Line and Detail");
});

it("requires the window edge and page scroll proof on every surface, width and appearance", () => {
  for (const shot of report.views) {
    expect(() =>
      assertSmokeViews(
        report.views.map((item) =>
          item === shot
            ? {
                ...item,
                geometry: item.geometry.filter((check) => check.rule !== "window"),
              }
            : item,
        ),
      ),
    ).toThrow();
    expect(() =>
      assertSmokeViews(
        report.views.map((item) =>
          item === shot
            ? {
                ...item,
                geometry: item.geometry.map((check) =>
                  check.rule === "window"
                    ? {
                        ...check,
                        scroll: { width: shot.viewportWidth, height: 1057 },
                      }
                    : check,
                ),
              }
            : item,
        ),
      ),
    ).toThrow(/Page scroll/);
  }
});
it("fails undersized or truncated images", () => {
  const image = syntheticImage(24, 20000);
  for (const mutation of [{ width: 639 }, { height: 399 }, { bytes: 1023 }]) {
    expect(() => assertSmokeShot("today", { ...image, ...mutation }, qualifiers)).toThrow(
      "Screenshot too small",
    );
  }
  expect(() =>
    assertSmokeShot("today", { ...image, bitmap: image.bitmap.subarray(4) }, qualifiers),
  ).toThrow("Invalid bitmap");
});

it.each(["today", "upstream", "service", "detail"])(
  "fails when %s lacks its envelope qualifier at capture time",
  (surface) => {
    const image = syntheticImage(24, 20000);
    expect(() => assertSmokeShot(surface, image, ["swept 08:02", ""])).toThrow(
      "Missing envelope qualifier",
    );
    expect(() => assertSmokeShot(surface, image, ["", qualifiers[1]])).toThrow(
      "Missing sweep qualifier",
    );
    const mutation = report.views.map((shot) =>
      shot.surface === surface ? { ...shot, qualifiers: ["swept 08:02", ""] } : shot,
    );
    expect(() => assertSmokeViews(mutation)).toThrow("Missing envelope qualifier");
  },
);

it("rejects a blank image recorded in the terminal manifest", () => {
  expect(() =>
    assertSmokeViews(
      report.views.map((shot, index) =>
        index === 0 ? { ...shot, dominantFraction: 0.995 } : shot,
      ),
    ),
  ).toThrow("Blank screenshot");
});

it.each([
  { signal: "SIGTERM" },
  { hostPids: [102, 103] },
  { hostPids: [102, 103, 104, 105, 106, 107, 108, 108] },
  { channelTransfers: 8 },
  { fromCursor: 0 },
  { resumedCursor: 1 },
  { persistedCursors: [2] },
  { sameRenderer: false },
  { freshChannel: false },
  { giveUpAcrossReload: false },
  { reloadExactlyOnce: false },
  { lateSubframeNoReconnect: false },
  { canceledNavigationNoReconnect: false },
])("rejects incomplete supervision evidence: %j", (failure) => {
  expect(() =>
    assertSmokeReport({ ...report, supervision: { ...report.supervision, ...failure } }),
  ).toThrow();
});

const mornings = report.views.filter((shot) => shot.morning);
const withMorning = (
  match: (shot: SmokeReport["views"][number]) => boolean,
  change: (shot: SmokeReport["views"][number]) => Partial<SmokeReport["views"][number]>,
) =>
  JSON.parse(
    JSON.stringify(report.views.map((shot) => (match(shot) ? { ...shot, ...change(shot) } : shot))),
  );
const evidence = (
  shot: SmokeReport["views"][number],
  change: { [K in keyof MorningEvidence]?: MorningEvidence[K] | undefined },
) => ({ morning: { ...shot.morning, ...change } as MorningEvidence });

it("lists Today on calm, busy and bad at 1440 and 740 in both appearances, and Detail open at 1440", () => {
  expect(
    mornings.map(
      ({ surface, viewportWidth, appearance }) => `${surface}/${viewportWidth}/${appearance}`,
    ),
  ).toHaveLength(18);
  for (const morning of ["calm", "busy", "bad"])
    for (const id of [`today-${morning}`, `today-${morning}-detail`])
      for (const appearance of ["light", "dark"]) {
        const widths = id.endsWith("-detail") ? [1440] : [1440, 740];
        for (const viewportWidth of widths) {
          const matches = (shot: SmokeReport["views"][number]) =>
            shot.surface === id &&
            shot.viewportWidth === viewportWidth &&
            shot.appearance === appearance;
          expect(report.views.filter(matches)).toHaveLength(1);
          expect(() => assertSmokeViews(report.views.filter((shot) => !matches(shot)))).toThrow(
            "Missing screenshot",
          );
          expect(() =>
            assertSmokeViews(
              report.views.map((shot) =>
                matches(shot)
                  ? { ...shot, appearance: appearance === "light" ? "dark" : "light" }
                  : shot,
              ),
            ),
          ).toThrow(`Missing or duplicate screenshot: ${id}/${viewportWidth}/`);
        }
      }
});

it("fails the bad morning without its caveat band, and a calm or busy one with a caveat", () => {
  expect(() =>
    assertSmokeViews(
      withMorning(
        (shot) => shot.surface === "today-bad" && shot.viewportWidth === 740,
        () => ({ qualifiers: ["Swept 08:02", ""] }),
      ),
    ),
  ).toThrow("Missing caveat band qualifier: today-bad/740");
  expect(() =>
    assertSmokeViews(
      withMorning(
        (shot) => shot.surface === "today-bad-detail",
        () => ({ qualifiers: ["Swept 08:02", "GitLab reads failed; items may be missing."] }),
      ),
    ),
  ).toThrow("Missing caveat band qualifier: today-bad-detail/1440");
  expect(() =>
    assertSmokeViews(
      withMorning(
        (shot) => shot.surface === "today-bad" && shot.appearance === "dark",
        (shot) => evidence(shot, { blocks: morningBlocks.busy }),
      ),
    ),
  ).toThrow("Missing block caveat: today-bad/1440");
  for (const surface of ["today-calm", "today-busy-detail"])
    expect(() =>
      assertSmokeViews(
        withMorning(
          (shot) => shot.surface === surface,
          () => ({
            qualifiers: [
              "Swept 08:02",
              "GitHub issues and PRs read failed at 08:02; items from it may be missing. Evidence ›",
            ],
          }),
        ),
      ),
    ).toThrow(`Unexpected caveat band: ${surface}/`);
});

it("fails a capture that stops at window height or leaves a block outside the image", () => {
  const atWindow = withMorning(
    (shot) => shot.surface === "today-busy" && shot.viewportWidth === 1440,
    (shot) => ({ height: 1600, ...evidence(shot, { pageHeight: 800 }) }),
  );
  expect(() => assertSmokeViews(atWindow)).toThrow("Capture stops above the fold: today-busy/1440");
  const cropped = withMorning(
    (shot) => shot.surface === "today-calm" && shot.viewportWidth === 740,
    () => ({ height: 1000 * 2 }),
  );
  expect(() => assertSmokeViews(cropped)).toThrow("Image is not the full page: today-calm/740");
  const below = withMorning(
    (shot) => shot.surface === "today-bad-detail",
    (shot) =>
      evidence(shot, {
        blocks: morningBlocks.bad.map((block) =>
          block.name === "releases" ? { ...block, top: 1600 } : block,
        ),
      }),
  );
  expect(() => assertSmokeViews(below)).toThrow(
    "Block releases outside the capture: today-bad-detail/1440",
  );
  const noReleases = withMorning(
    (shot) => shot.surface === "today-calm",
    (shot) =>
      evidence(shot, {
        blocks: morningBlocks.calm.filter(({ name }) => name !== "releases"),
      }),
  );
  expect(() => assertSmokeViews(noReleases)).toThrow("Missing block releases: today-calm/1440");
  const noMotion = withMorning(
    (shot) => shot.surface === "today-calm-detail",
    (shot) =>
      evidence(shot, { blocks: morningBlocks.calm.filter(({ name }) => name !== "motion") }),
  );
  expect(() => assertSmokeViews(noMotion)).toThrow("Missing block motion: today-calm-detail/1440");
  const reordered = withMorning(
    (shot) => shot.surface === "today-busy",
    (shot) => evidence(shot, { blocks: [...morningBlocks.busy].reverse() }),
  );
  expect(() => assertSmokeViews(reordered)).toThrow("Blocks out of order: today-busy/1440");
});

it.each(["calm", "busy", "bad"] as const)("fails the %s morning without its horizon", (morning) => {
  const noHorizon = withMorning(
    (shot) => shot.surface === `today-${morning}` && shot.viewportWidth === 740,
    (shot) =>
      evidence(shot, {
        blocks: morningBlocks[morning].filter(({ name }) => name !== "horizon"),
      }),
  );
  expect(() => assertSmokeViews(noHorizon)).toThrow(`Missing block horizon: today-${morning}/740`);
});

it("fails a morning without its fixture, decision sections, headline, Detail or geometry", () => {
  const cases: [string, (shot: SmokeReport["views"][number]) => object, string][] = [
    ["today-calm", () => ({ morning: undefined }), "Missing morning evidence"],
    ["today-busy", (shot) => evidence(shot, { fixture: "snapshot-1106.json" }), "Wrong fixture"],
    [
      "today-bad",
      (shot) => evidence(shot, { sections: morningSections("bad", false, 1440) }),
      "Wrong decision sections: today-bad/740",
    ],
    ["today-calm", (shot) => evidence(shot, { headline: "" }), "Wrong headline"],
    ["today-busy-detail", (shot) => evidence(shot, { detailTitle: undefined }), "Missing Detail"],
    [
      "today-busy",
      (shot) => evidence(shot, { detailTitle: "partition v1.3.3" }),
      "Unexpected Detail",
    ],
    ["today-bad", () => ({ geometry: [] }), "Missing geometry"],
    [
      "today-busy",
      (shot) => ({ geometry: shot.geometry.filter(({ rule }) => rule !== "release-platform") }),
      "Missing geometry",
    ],
  ];
  for (const [surface, change, message] of cases)
    expect(() =>
      assertSmokeViews(
        withMorning(
          (shot) =>
            shot.surface === surface && (surface !== "today-bad" || shot.viewportWidth === 740),
          change,
        ),
      ),
    ).toThrow(message);
});

it("names decision.md's sections per morning, width and Detail state", () => {
  expect(morningSections("calm", false, 1440)).toEqual([
    "Calm and bad mornings: Calm",
    "Calm first (draft 7)",
    "On the horizon: what's coming from GitLab (draft 7)",
    "Words and visuals (draft 7)",
  ]);
  expect(morningSections("bad", false, 740)).toContain(
    "One column: 740 px, and 1440 with Detail open (centre about 850)",
  );
  expect(morningSections("busy", true, 1440)).toEqual(
    expect.arrayContaining([
      "Today at 1440 × 900 (sidebar 232, centre 1208, Detail closed), this morning's data",
      "One column: 740 px, and 1440 with Detail open (centre about 850)",
      "Click targets: a version opens that service's release in Detail",
    ]),
  );
});
