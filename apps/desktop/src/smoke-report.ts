// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { APPENDIX_A_TOOLS } from "@spi-code/host";
import { assertSmokeGeometry, type SmokeGeometry } from "./smoke-geometry.js";
import type { SupervisionReport } from "./smoke-supervision.js";

export const VIEW_WIDTHS = [1440, 900, 740] as const;

export const VIEW_SURFACES = [
  {
    id: "today",
    name: "Today",
    route: "today",
    place: "Today",
    selector: ".today .place-reading",
    designSection: "The window / Today at rest",
    qualified: true,
  },
  {
    id: "strip",
    name: "The strip",
    route: "today",
    place: "Today",
    selector: "[data-strip]",
    designSection: "The window; A / New: strip",
    qualified: true,
  },
  {
    id: "line",
    name: "The Line sheet",
    route: "today",
    place: "Today",
    selector: ".line-sheet[data-presentation=overlay] .line-grid",
    designSection: "The window / The Line sheet",
    qualified: true,
  },
  {
    id: "upstream",
    name: "Upstream",
    route: "upstream",
    place: "Upstream",
    selector: ".upstream .place-reading",
    designSection: "The window / Upstream",
    qualified: true,
  },
  {
    id: "environment",
    name: "Environment",
    route: "environment",
    place: "Environment",
    selector: ".environment .place-reading",
    designSection: "The window / Places",
    qualified: false,
  },
  {
    id: "engineering-system",
    name: "Engineering system",
    route: "engineering-system",
    place: "Engineering system",
    selector: ".place[aria-label='Engineering system'] .place-reading",
    designSection: "The window / Places",
    qualified: false,
  },
  {
    id: "releases",
    name: "Releases",
    route: "releases",
    place: "Releases",
    selector: ".place[aria-label=Releases] .place-reading",
    designSection: "The window / Places",
    qualified: false,
  },
  {
    id: "security",
    name: "Security",
    route: "security",
    place: "Security",
    selector: ".place[aria-label=Security] .place-reading",
    designSection: "The window / Places",
    qualified: false,
  },
  {
    id: "service",
    name: "Service: entitlements",
    route: "service/entitlements",
    place: "entitlements",
    selector: ".place[aria-label=entitlements] .place-reading",
    designSection: "The window / Places (service reading)",
    qualified: true,
  },
  {
    id: "detail",
    name: "Detail: detected os-core-common 8.5.0",
    route: "upstream",
    place: "Upstream",
    selector: "aside[aria-label=Detail] .detail-row-fields",
    designSection: "A / PS-04; Journeys; D / Detail defects",
    qualified: true,
  },
  {
    id: "settings",
    name: "Settings / Readiness",
    route: "today",
    place: "Today",
    selector:
      "[role=dialog] [data-settings-section=readiness] .readiness-row[aria-label='GitHub API budget']",
    designSection: "Layout / Settings (Readiness, opened from the sidebar footer); PRD PS-08",
    qualified: false,
  },
  {
    id: "settings-first-launch",
    name: "Settings / Readiness on first launch",
    route: "today",
    place: "Today",
    selector: "[role=dialog] .settings-readiness-banner[data-readiness=attention]",
    designSection: "Layout / Settings: first launch over the Watch gate",
    qualified: false,
  },
  {
    id: "settings-failed",
    name: "Settings / Failed glab sign-in",
    route: "today",
    place: "Today",
    selector: "[role=dialog] .readiness-row[aria-label=glab] [role=alert]",
    designSection: "Layout / Settings: a failed sign-in",
    qualified: false,
  },
  {
    id: "settings-appearance",
    name: "Settings / Appearance",
    route: "today",
    place: "Today",
    selector: "[role=dialog] [data-settings-section=appearance]",
    designSection: "Layout / Settings: Appearance",
    qualified: false,
  },
  {
    id: "detail-related",
    name: "Detail / Long Related label at 280 px",
    route: "upstream",
    place: "Upstream",
    selector: ".inspector-related",
    designSection: "Layout / Detail panel; Validation",
    qualified: true,
  },
  {
    id: "panes",
    name: "Pinned Line and Detail",
    route: "upstream",
    place: "Upstream",
    selector: ".line-sheet:not([data-presentation=overlay]) .line-grid",
    designSection: "Layout / Panes and surfaces; Width budget",
    qualified: true,
  },
  {
    id: "strip-20",
    name: "Top row / 20 services",
    route: "today",
    place: "Today",
    selector: "[data-strip] [data-service=smoke-service-20]",
    designSection: "Layout / Top row at 740 px on Windows, 20 services",
    qualified: true,
  },
] as const;

export function geometryRules(surface: string, width: number): SmokeGeometry["rule"][] {
  if (surface.startsWith("settings")) return ["window", "settings"];
  if (surface === "detail-related") return ["window", "related"];
  if (surface === "panes" && width === 1440) return ["window", "panes", "headers"];
  if (surface === "strip-20" && width === 740) return ["window", "drag"];
  return ["window"];
}

export interface SmokeShot {
  surface: string;
  appearance: "light" | "dark";
  viewportWidth: number;
  file: string;
  width: number;
  height: number;
  bytes: number;
  dominantFraction: number;
  qualifiers: string[];
  geometry: SmokeGeometry[];
  rejectedGeometry?: string;
}

export function assertSmokeShot(
  surfaceId: string,
  image: { width: number; height: number; bitmap: Uint8Array; bytes: number } | undefined,
  qualifiers: readonly string[],
): Pick<SmokeShot, "width" | "height" | "bytes" | "dominantFraction" | "qualifiers"> {
  assert(image, `Missing screenshot: ${surfaceId}`);
  const { width, height, bitmap, bytes } = image;
  assert(width >= 640 && height >= 400 && bytes >= 1024, `Screenshot too small: ${surfaceId}`);
  assert.equal(bitmap.length, width * height * 4, `Invalid bitmap: ${surfaceId}`);
  const buckets = new Uint32Array(4096);
  let dominant = 0;
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const bucket =
      ((bitmap[offset] ?? 0) >> 4) |
      (((bitmap[offset + 1] ?? 0) >> 4) << 4) |
      (((bitmap[offset + 2] ?? 0) >> 4) << 8);
    const count = (buckets[bucket] ?? 0) + 1;
    buckets[bucket] = count;
    dominant = Math.max(dominant, count);
  }
  const dominantFraction = dominant / (width * height);
  assert(dominantFraction < 0.995, `Blank screenshot: ${surfaceId}`);
  assertSmokeQualifiers(surfaceId, qualifiers);
  return { width, height, bytes, dominantFraction, qualifiers: [...qualifiers] };
}

function assertSmokeQualifiers(surfaceId: string, qualifiers: unknown): void {
  const surface = VIEW_SURFACES.find(({ id }) => id === surfaceId);
  assert(surface, `Unknown surface: ${surfaceId}`);
  assert(Array.isArray(qualifiers) && qualifiers.every((text) => typeof text === "string"));
  assert(/swept/i.test(qualifiers[0] ?? ""), `Missing sweep qualifier: ${surfaceId}`);
  if (surface.qualified && !["strip", "line"].includes(surfaceId))
    assert(
      /failed|incomplete|truncated/i.test(qualifiers[1] ?? ""),
      `Missing envelope qualifier: ${surfaceId}`,
    );
}

export function assertSmokeViews(value: unknown): asserts value is SmokeShot[] {
  assert(Array.isArray(value), "Missing views step");
  assert.equal(value.length, VIEW_SURFACES.length * VIEW_WIDTHS.length * 2, "Missing screenshot");
  for (const { id } of VIEW_SURFACES) {
    for (const viewportWidth of VIEW_WIDTHS) {
      for (const appearance of ["light", "dark"]) {
        const matches: Record<string, unknown>[] = value.filter(
          (shot: unknown): shot is Record<string, unknown> =>
            shot !== null &&
            typeof shot === "object" &&
            "surface" in shot &&
            shot.surface === id &&
            "viewportWidth" in shot &&
            shot.viewportWidth === viewportWidth &&
            "appearance" in shot &&
            shot.appearance === appearance,
        );
        assert.equal(
          matches.length,
          1,
          `Missing or duplicate screenshot: ${id}/${viewportWidth}/${appearance}`,
        );
        const [shot] = matches;
        assert(shot);
        assert.equal(shot.file, `views/${id}-${viewportWidth}-${appearance}.png`);
        assert(
          typeof shot.width === "number" &&
            shot.width >= 640 &&
            typeof shot.height === "number" &&
            shot.height >= 400 &&
            typeof shot.bytes === "number" &&
            shot.bytes >= 1024,
          "Screenshot too small",
        );
        assert(
          typeof shot.dominantFraction === "number" &&
            shot.dominantFraction >= 0 &&
            shot.dominantFraction < 0.995,
          "Blank screenshot",
        );
        assertSmokeQualifiers(id, shot.qualifiers);
        assert(
          Array.isArray(shot.geometry),
          `Missing geometry: ${id}/${viewportWidth}/${appearance}`,
        );
        const rules = geometryRules(id, viewportWidth);
        assert.equal(
          shot.geometry.length,
          rules.length,
          `Missing geometry rules: ${id}/${viewportWidth}/${appearance}`,
        );
        for (const [index, geometry] of shot.geometry.entries()) {
          assertSmokeGeometry(geometry);
          assert.equal(geometry.rule, rules[index], `Wrong geometry rule: ${id}`);
        }
        if (id === "detail-related" && viewportWidth === 1440 && appearance === "light") {
          assert.equal(
            shot.rejectedGeometry,
            "Related value squeezed to 159 px",
            "Missing packaged broken-rule proof",
          );
        }
      }
    }
  }
}

export interface SmokeReport {
  mainPid: number;
  hostPid: number;
  restartedHostPid: number;
  rendererPids: number[];
  mainNodeVersion: string;
  hostNodeVersion: string;
  sqliteIsTransaction: true;
  tray: boolean;
  rendererRoundTrip: boolean;
  reloadRoundTrip: boolean;
  permissionDenied: boolean;
  permissionQueryDenied: boolean;
  malformed: "rejected" | "accepted";
  rowSurvived: true;
  listeners: string[];
  tools: { name: string; outcome: "completed" | "refused" | "error" }[];
  deniedBuiltIn: { name: string; outcome: "refused" };
  supervision: SupervisionReport;
  views: SmokeShot[];
}

export function assertSmokeReport(value: unknown): asserts value is SmokeReport {
  assert(value !== null && typeof value === "object", "Smoke report must be an object");
  const report = value as Record<string, unknown>;
  for (const key of ["mainPid", "hostPid", "restartedHostPid"]) {
    assert(Number.isSafeInteger(report[key]) && Number(report[key]) > 0, `${key} must be a pid`);
  }
  assert.equal(new Set([report.mainPid, report.hostPid, report.restartedHostPid]).size, 3);
  assert(Array.isArray(report.rendererPids) && report.rendererPids.length > 0);
  for (const pid of report.rendererPids) {
    assert(Number.isSafeInteger(pid) && pid > 0, "rendererPids must contain pids");
    assert(![report.mainPid, report.hostPid, report.restartedHostPid].includes(pid));
  }
  for (const key of ["mainNodeVersion", "hostNodeVersion"]) {
    assert(typeof report[key] === "string" && /^\d+\.\d+\.\d+$/.test(report[key]));
    const [major, minor] = report[key].split(".").map(Number);
    assert(
      major !== undefined && minor !== undefined && (major > 22 || (major === 22 && minor >= 16)),
    );
  }
  assert.equal(report.sqliteIsTransaction, true);
  assert.equal(report.tray, true, "Packaged smoke must show the tray present");
  assert.equal(report.rendererRoundTrip, true);
  assert.equal(report.reloadRoundTrip, true);
  assert.equal(report.permissionDenied, true);
  assert.equal(report.permissionQueryDenied, true);
  assert.equal(report.malformed, "rejected");
  assert.equal(report.rowSurvived, true);
  assert.deepEqual(report.listeners, []);
  assertSmokeViews(report.views);
  assertSmokeTools(report.tools, report.deniedBuiltIn);
  assert(report.supervision !== null && typeof report.supervision === "object");
  const supervision = report.supervision as Record<string, unknown>;
  assert.equal(supervision.signal, "SIGKILL");
  assert(Array.isArray(supervision.hostPids) && supervision.hostPids.length === 8);
  for (const pid of supervision.hostPids) assert(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(new Set(supervision.hostPids).size, 8);
  assert.equal(supervision.hostPids[0], report.hostPid);
  assert.equal(supervision.hostPids[1], report.restartedHostPid);
  assert.equal(supervision.channelTransfers, 9);
  assert(Number.isSafeInteger(supervision.fromCursor) && Number(supervision.fromCursor) > 0);
  assert(
    Number.isSafeInteger(supervision.resumedCursor) &&
      Number(supervision.resumedCursor) > Number(supervision.fromCursor),
  );
  assert.deepEqual(supervision.persistedCursors, [
    supervision.fromCursor,
    supervision.resumedCursor,
  ]);
  assert.equal(supervision.sameRenderer, true);
  assert.equal(supervision.freshChannel, true);
  assert.equal(supervision.giveUpAcrossReload, true);
  assert.equal(supervision.reloadExactlyOnce, true);
  assert.equal(supervision.lateSubframeNoReconnect, true);
  assert.equal(supervision.canceledNavigationNoReconnect, true);
}

export function assertSmokeTools(
  value: unknown,
  deniedBuiltIn: unknown,
): asserts deniedBuiltIn is SmokeReport["deniedBuiltIn"] {
  assert(Array.isArray(value));
  const tools = value as SmokeReport["tools"];
  assert.equal(tools.length, APPENDIX_A_TOOLS.length);
  assert.equal(new Set(tools.map(({ name }) => name)).size, APPENDIX_A_TOOLS.length);
  for (const { name, tier } of APPENDIX_A_TOOLS) {
    const observed = tools.find((tool) => tool.name === name);
    assert(observed, `Missing tool: ${name}`);
    assert.equal(observed.outcome, tier === "Read" ? "completed" : "refused");
  }
  assert(deniedBuiltIn !== null && typeof deniedBuiltIn === "object");
  assert("name" in deniedBuiltIn && deniedBuiltIn.name === "builtin:shell");
  assert("outcome" in deniedBuiltIn && deniedBuiltIn.outcome === "refused");
}
