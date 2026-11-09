// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import { expect, it } from "vitest";
import { APPENDIX_A_TOOLS } from "../../../packages/host/src/tools/tool-names.js";
import type { SmokeGeometry } from "./smoke-geometry.js";
import {
  assertSmokeReport,
  assertSmokeShot,
  assertSmokeViews,
  geometryRules,
  type SmokeReport,
  VIEW_SURFACES,
  VIEW_WIDTHS,
} from "./smoke-report.js";
import { smokeSweepProgress } from "./smoke-sweep.js";

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
  views: VIEW_SURFACES.flatMap(({ id }) =>
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
        qualifiers: firstSweepQualifiers[id] ?? [
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
