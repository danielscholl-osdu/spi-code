// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";

export interface SmokeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SmokeGeometry =
  | {
      rule: "window";
      viewport: SmokeRect;
      scroll: { width: number; height: number };
      panes: SmokeRect[];
    }
  | {
      rule: "release-platform";
      platform: SmokeRect;
      versions: number;
      library: {
        bounds: SmokeRect;
        bar: SmokeRect;
        segments: SmokeRect[];
        counts: SmokeRect;
        text: SmokeRect[];
      } | null;
    }
  | { rule: "related"; panel: SmokeRect; label: SmokeRect; labelText: string; values: SmokeRect[] }
  | {
      rule: "panes";
      viewport: SmokeRect;
      scroll: { width: number; height: number };
      panes: { rect: SmokeRect; borderLeft: number; borderRight: number }[];
    }
  | { rule: "headers"; panes: SmokeRect[]; headers: { rect: SmokeRect; rule: number }[] }
  | { rule: "settings"; viewport: SmokeRect; dialog: SmokeRect }
  | { rule: "sweep-visible"; viewport: SmokeRect; panel: SmokeRect; elements: SmokeRect[] }
  | {
      rule: "sweep-reads";
      width: number;
      picker: string | null;
      rows: { name: SmokeRect; cadence: SmokeRect; lastRead: SmokeRect; label: string }[];
    }
  | {
      rule: "failed-reads";
      section: SmokeRect;
      panel: SmokeRect;
      rows: { source: string; outcome: string }[];
    }
  | {
      rule: "drag";
      services: number;
      controls: "inset" | "overlay" | "none";
      /** The top row less the native window controls: Windows' titlebar area, else the whole row. */
      clear: SmokeRect;
      viewport: SmokeRect;
      centre: SmokeRect;
      capsule: SmokeRect;
      detailSheet: boolean;
      regions: SmokeAppRegion[];
      targets: { label: string; rect: SmokeRect }[];
    }
  | {
      rule: "overlay-drag";
      overlay: string;
      viewport: SmokeRect;
      regions: SmokeAppRegion[];
      targets: { label: string; rect: SmokeRect }[];
      backdrop?: SmokeRect;
    };

export interface SmokeAppRegion {
  appRegion: "drag" | "no-drag";
  rect: SmokeRect;
}

function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === "object", "Missing geometry");
}

function rect(value: unknown): asserts value is SmokeRect {
  record(value);
  for (const key of ["x", "y", "width", "height"]) {
    assert(typeof value[key] === "number" && Number.isFinite(value[key]), `Invalid rect ${key}`);
  }
  assert(Number(value.width) > 0 && Number(value.height) > 0, "Empty geometry rect");
}

function aligned(actual: number, expected: number, message: string): void {
  assert(Math.abs(actual - expected) < 0.02, `${message}: ${actual} != ${expected}`);
}

function contains(panel: SmokeRect, item: SmokeRect): boolean {
  return (
    item.x >= panel.x &&
    item.y >= panel.y &&
    item.x + item.width <= panel.x + panel.width &&
    item.y + item.height <= panel.y + panel.height
  );
}

function windowEdges(viewport: unknown, scroll: unknown, panes: SmokeRect[]): void {
  rect(viewport);
  record(scroll);
  for (const key of ["width", "height"] as const) {
    assert(
      typeof scroll[key] === "number" && Number.isFinite(scroll[key]),
      `Invalid page scroll ${key}`,
    );
    aligned(scroll[key], viewport[key], `Page scroll ${key}`);
  }
  aligned(viewport.x, 0, "Viewport left");
  aligned(viewport.y, 0, "Viewport top");
  assert(panes.length > 0, "Window panes missing");
  for (const pane of panes) {
    rect(pane);
    assert(
      pane.x >= 0 &&
        pane.y >= 0 &&
        pane.x + pane.width <= viewport.width + 0.02 &&
        pane.y + pane.height <= viewport.height + 0.02,
      "Pane outside window",
    );
  }
  aligned(Math.min(...panes.map((pane) => pane.x)), 0, "Pane row left");
  aligned(Math.max(...panes.map((pane) => pane.x + pane.width)), viewport.width, "Pane row right");
  aligned(
    Math.max(...panes.map((pane) => pane.y + pane.height)),
    viewport.height,
    "Pane row bottom",
  );
}

/** The widest stretch of the region's row that no target covers. */
export function dragGap(region: SmokeRect, targets: readonly SmokeRect[]): SmokeRect {
  let edge = region.x;
  let gap = { x: region.x, width: 0 };
  for (const target of targets
    .filter((target) => target.y < region.y + region.height && target.y + target.height > region.y)
    .sort((a, b) => a.x - b.x)) {
    const start = Math.max(region.x, Math.min(region.x + region.width, target.x));
    if (start - edge > gap.width) gap = { x: edge, width: start - edge };
    edge = Math.max(edge, Math.min(region.x + region.width, target.x + target.width));
  }
  if (region.x + region.width - edge > gap.width)
    gap = { x: edge, width: region.x + region.width - edge };
  return { ...gap, y: region.y, height: region.height };
}

/**
 * Electron builds the window's drag shape by walking app regions in order, adding each drag
 * rect and subtracting each no-drag rect, with no regard for what paints on top. A target is
 * dragged when any part of it is left in that shape.
 */
export function inDragShape(regions: readonly SmokeAppRegion[], target: SmokeRect): boolean {
  const cuts = (start: number, size: number, edges: number[]) =>
    [...new Set([start, start + size, ...edges.filter((e) => e > start && e < start + size)])].sort(
      (a, b) => a - b,
    );
  const xs = cuts(
    target.x,
    target.width,
    regions.flatMap(({ rect }) => [rect.x, rect.x + rect.width]),
  );
  const ys = cuts(
    target.y,
    target.height,
    regions.flatMap(({ rect }) => [rect.y, rect.y + rect.height]),
  );
  const mids = (cuts: number[]) =>
    cuts.slice(1).map((cut, index) => (cut + (cuts[index] ?? cut)) / 2);
  for (const x of mids(xs))
    for (const y of mids(ys)) {
      let drag = false;
      for (const { appRegion, rect } of regions)
        if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height)
          drag = appRegion === "drag";
      if (drag) return true;
    }
  return false;
}

export function assertSmokeGeometry(
  value: unknown,
  viewportWidth?: number,
): asserts value is SmokeGeometry {
  record(value);
  switch (value.rule) {
    case "release-platform": {
      rect(value.platform);
      assert(
        Number.isInteger(value.versions) && Number(value.versions) >= 0,
        "Library versions missing",
      );
      if (value.versions === 0) {
        assert.equal(value.library, null, "Unexpected library distribution");
        break;
      }
      record(value.library);
      const { bounds, bar, segments, counts, text } = value.library;
      rect(bounds);
      rect(bar);
      rect(counts);
      const evidence = JSON.stringify(value);
      assert(contains(value.platform, bounds), `Library outside Platform row: ${evidence}`);
      assert(contains(bounds, bar) && contains(bounds, counts), `Library clipped: ${evidence}`);
      assert(
        Array.isArray(segments) && segments.length === value.versions,
        "Library segments missing",
      );
      for (const segment of segments) {
        rect(segment);
        assert(contains(bar, segment), `Library segment outside bar: ${evidence}`);
      }
      assert(Array.isArray(text) && text.length > 0, "Library counts missing");
      for (const fragment of text) {
        rect(fragment);
        assert(contains(counts, fragment), `Library counts clipped: ${evidence}`);
      }
      assert(
        counts.y >= bar.y + bar.height ||
          (counts.x >= bar.x + bar.width && counts.y + counts.height > bar.y),
        `Library counts must sit beside or below bar: ${evidence}`,
      );
      break;
    }
    case "sweep-visible": {
      rect(value.viewport);
      rect(value.panel);
      assert(contains(value.viewport, value.panel), "Sweep panel outside viewport");
      assert(Array.isArray(value.elements) && value.elements.length >= 2, "Sweep elements missing");
      for (const element of value.elements) {
        rect(element);
        assert(
          contains(value.panel, element),
          `Sweep element outside panel: ${JSON.stringify(value)}`,
        );
      }
      break;
    }
    case "sweep-reads": {
      assert(
        typeof value.width === "number" && Number.isFinite(value.width),
        "Sweep width missing",
      );
      assert(Array.isArray(value.rows) && value.rows.length === 4, "Sweep source rows missing");
      const narrow = (viewportWidth ?? value.width) === 740;
      if (narrow) assert.equal(value.picker, "Sweep", "Sweep picker must read Sweep");
      for (const row of value.rows) {
        record(row);
        rect(row.name);
        rect(row.cadence);
        rect(row.lastRead);
        if (narrow) {
          assert.equal(row.label, "last read", "Sweep last-read label missing");
          assert(
            row.cadence.y >= row.name.y + row.name.height &&
              row.lastRead.y >= row.name.y + row.name.height,
            "Sweep columns must fold below source",
          );
        }
      }
      if (viewportWidth !== undefined)
        assert.equal(value.width, viewportWidth, "Sweep measured width differs from shot");
      break;
    }
    case "failed-reads": {
      rect(value.section);
      rect(value.panel);
      const evidence = JSON.stringify(value);
      assert(
        value.section.y >= value.panel.y &&
          value.section.y + value.section.height <= value.panel.y + value.panel.height,
        `Failed reads outside panel: ${evidence}`,
      );
      assert.deepEqual(
        value.rows,
        [
          {
            source: "GitHub issues and PRs",
            outcome: "read failed · unit, crs-catalog, crs-conversion",
          },
        ],
        `Failed-read wording: ${evidence}`,
      );
      break;
    }
    case "window": {
      assert(Array.isArray(value.panes), "Window panes missing");
      for (const pane of value.panes) rect(pane);
      windowEdges(value.viewport, value.scroll, value.panes);
      break;
    }
    case "related": {
      rect(value.panel);
      rect(value.label);
      aligned(value.panel.width, 280, "Related panel must exercise 280 px");
      assert(
        typeof value.labelText === "string" && value.labelText.length >= 70,
        "Related long label missing",
      );
      assert(value.label.height > 30, "Related long label did not wrap");
      assert(Array.isArray(value.values) && value.values.length > 0, "Related values missing");
      for (const item of value.values) {
        rect(item);
        assert(item.width >= 160, `Related value squeezed to ${item.width} px`);
        assert(
          item.x >= value.panel.x && item.x + item.width <= value.panel.x + value.panel.width,
          "Related value outside panel",
        );
      }
      assert(
        value.values[0].y >= value.label.y + value.label.height,
        "Related label must stack above value",
      );
      break;
    }
    case "panes": {
      assert(
        Array.isArray(value.panes) && value.panes.length === 4,
        "Pane probe requires sidebar, centre, Line and Detail",
      );
      let previous: { rect: SmokeRect; borderRight: number } | undefined;
      for (const pane of value.panes) {
        record(pane);
        rect(pane.rect);
        aligned(pane.rect.y, 0, "Pane top");
        assert(
          typeof pane.borderLeft === "number" && typeof pane.borderRight === "number",
          "Pane divider missing",
        );
        if (previous) {
          aligned(pane.rect.x, previous.rect.x + previous.rect.width, "Pane gap");
          aligned(pane.rect.y, previous.rect.y, "Pane top");
          aligned(pane.rect.height, previous.rect.height, "Pane height");
          aligned(previous.borderRight + pane.borderLeft, 1, "Pane divider must be 1 px");
        }
        previous = { rect: pane.rect, borderRight: pane.borderRight };
      }
      windowEdges(
        value.viewport,
        value.scroll,
        value.panes.map((pane) => pane.rect),
      );
      break;
    }
    case "headers": {
      assert(
        Array.isArray(value.headers) && value.headers.length > 0,
        "Header probe requires visible pane headers",
      );
      assert(
        Array.isArray(value.panes) && value.panes.length === value.headers.length,
        "Header panes missing",
      );
      let rules = 0;
      for (const [index, header] of value.headers.entries()) {
        record(header);
        rect(header.rect);
        const pane = value.panes[index];
        rect(pane);
        assert(typeof header.rule === "number", "Header rule missing");
        aligned(pane.y, 0, "Pane top");
        aligned(header.rect.y, 0, "Header top");
        aligned(header.rect.height, 44, "Header height");
        aligned(header.rect.x, pane.x, "Header left");
        aligned(header.rect.width, pane.width, "Header width");
        if (header.rule > 0) {
          aligned(header.rule, 1, "Header rule");
          rules++;
        }
      }
      assert(rules > 0, "Header probe found no bottom rule");
      break;
    }
    case "settings": {
      rect(value.viewport);
      rect(value.dialog);
      const { viewport, dialog } = value;
      assert(dialog.width <= 820 && dialog.height <= 560, "Settings exceeds 820 x 560");
      for (const margin of [
        dialog.x - viewport.x,
        dialog.y - viewport.y,
        viewport.x + viewport.width - dialog.x - dialog.width,
        viewport.y + viewport.height - dialog.y - dialog.height,
      ])
        assert(margin >= 24, `Settings edge margin is ${margin} px, below 24`);
      break;
    }
    case "drag": {
      assert(Number.isInteger(value.services), "Drag probe services missing");
      assert(
        value.controls === "inset" || value.controls === "overlay" || value.controls === "none",
        "Window controls missing",
      );
      rect(value.clear);
      rect(value.viewport);
      rect(value.centre);
      rect(value.capsule);
      if (value.centre.width >= 1000) {
        const capsule = value.capsule.x + value.capsule.width / 2;
        const header = value.centre.x + value.centre.width / 2;
        assert(
          Math.abs(capsule - header) <= 1,
          `Capsule midpoint ${capsule} is not the centre header's ${header}`,
        );
      }
      aligned(value.clear.y, 0, "Top row top");
      aligned(value.clear.height, 44, "Top row height");
      if (value.controls === "overlay")
        assert(
          value.clear.x + value.clear.width <= value.viewport.width - 40,
          `Caption buttons not reported: ${JSON.stringify(value.clear)}`,
        );
      assert(Array.isArray(value.regions), "App regions missing");
      for (const region of value.regions) {
        record(region);
        rect(region.rect);
      }
      assert(Array.isArray(value.targets), "Drag targets missing");
      const labels: string[] = [];
      for (const target of value.targets) {
        record(target);
        rect(target.rect);
        const { x, y, width, height } = target.rect;
        const at = `${String(target.label)} at ${x},${y} ${width}x${height}`;
        assert(y >= -0.02 && y + height <= 44.02, `Top row target off the row: ${at}`);
        assert(
          x >= value.clear.x - 0.02 && x + width <= value.clear.x + value.clear.width + 0.02,
          `Top row target under the window controls: ${at}`,
        );
        assert(!inDragShape(value.regions, target.rect), `${at} lies in a drag rectangle`);
        labels.push(String(target.label));
      }
      assert.equal(
        labels.filter((label) => label === "Toggle sidebar").length,
        1,
        "Top row needs one sidebar toggle",
      );
      assert.equal(
        labels.filter((label) => label === "Toggle right panel" || label === "Close detail").length,
        value.detailSheet ? 0 : 1,
        "Top row needs one right-panel toggle",
      );
      const left = Math.max(value.centre.x, value.clear.x);
      const right = Math.min(
        value.centre.x + value.centre.width,
        value.clear.x + value.clear.width,
      );
      const gap = dragGap(
        { x: left, y: 0, width: right - left, height: 44 },
        value.targets.map((target) => target.rect),
      );
      assert(gap.width >= 48, `Drag area is ${gap.width} px, below 48`);
      assert(
        inDragShape(value.regions, {
          x: gap.x + gap.width / 2 - 0.5,
          y: 21.5,
          width: 1,
          height: 1,
        }),
        `Drag area at ${gap.x} is not a drag rectangle`,
      );
      break;
    }
    case "overlay-drag": {
      assert(typeof value.overlay === "string" && value.overlay, "Overlay name missing");
      rect(value.viewport);
      assert(Array.isArray(value.regions), "App regions missing");
      for (const region of value.regions) {
        record(region);
        assert(
          region.appRegion === "drag" || region.appRegion === "no-drag",
          `Invalid app region ${String(region.appRegion)}`,
        );
        rect(region.rect);
      }
      assert(
        value.regions.some((region) => region.appRegion === "drag"),
        "Overlay drag probe found no drag region",
      );
      assert(
        Array.isArray(value.targets) && value.targets.length > 0,
        `${value.overlay} has no interactive targets`,
      );
      const dragged: string[] = [];
      for (const target of value.targets) {
        record(target);
        rect(target.rect);
        const { x, y, width, height } = target.rect;
        if (inDragShape(value.regions, target.rect))
          dragged.push(`${String(target.label)} at ${x},${y} ${width}x${height}`);
      }
      if (value.backdrop !== undefined) {
        rect(value.backdrop);
        const { x, y, width, height } = value.backdrop;
        if (inDragShape(value.regions, value.backdrop))
          dragged.push(`backdrop at ${x},${y} ${width}x${height}`);
      }
      assert(
        dragged.length === 0,
        `${value.overlay} ${dragged.join("; ")} ${dragged.length === 1 ? "lies" : "lie"} in a drag rectangle`,
      );
      break;
    }
    default:
      assert.fail(`Unknown geometry rule: ${value.rule}`);
  }
}
