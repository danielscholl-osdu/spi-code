// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { APPENDIX_A_TOOLS } from "../../../packages/host/src/tools/tool-names.js";
import {
  assertSmokeReport,
  assertSmokeShot,
  assertSmokeViews,
  type SmokeReport,
  VIEW_SURFACES,
} from "./smoke-report.js";

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
    (["light", "dark"] as const).map((appearance) => ({
      surface: id,
      appearance,
      file: `views/${id}-${appearance}.png`,
      width: 1280,
      height: 800,
      bytes: 20000,
      dominantFraction: 0.6,
      qualifiers: ["swept 08:02 · 1 failed", "GitLab reads failed; items may be missing."],
    })),
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
