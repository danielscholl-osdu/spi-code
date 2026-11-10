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
  | { rule: "related"; panel: SmokeRect; label: SmokeRect; labelText: string; values: SmokeRect[] }
  | {
      rule: "panes";
      viewport: SmokeRect;
      scroll: { width: number; height: number };
      panes: { rect: SmokeRect; borderLeft: number; borderRight: number }[];
    }
  | { rule: "headers"; paneTop: number; panes: SmokeRect[]; headers: SmokeRect[] }
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
  | { rule: "drag"; services: number; appRegion: string; region: SmokeRect; targets: SmokeRect[] }
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

export function dragSpan(region: SmokeRect, targets: readonly SmokeRect[]): number {
  let edge = region.x;
  let span = 0;
  for (const target of targets
    .filter((target) => target.y < region.y + region.height && target.y + target.height > region.y)
    .sort((a, b) => a.x - b.x)) {
    const start = Math.max(region.x, Math.min(region.x + region.width, target.x));
    span = Math.max(span, start - edge);
    edge = Math.max(edge, Math.min(region.x + region.width, target.x + target.width));
  }
  return Math.max(span, region.x + region.width - edge);
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
    case "sweep-visible": {
      rect(value.viewport);
      rect(value.panel);
      assert(contains(value.viewport, value.panel), "Sweep panel outside viewport");
      assert(Array.isArray(value.elements) && value.elements.length >= 3, "Sweep elements missing");
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
        typeof value.paneTop === "number" && Number.isFinite(value.paneTop),
        "Header pane top missing",
      );
      assert(
        Array.isArray(value.headers) && value.headers.length > 0,
        "Header probe requires visible pane headers",
      );
      assert(
        Array.isArray(value.panes) && value.panes.length === value.headers.length,
        "Header panes missing",
      );
      for (const [index, header] of value.headers.entries()) {
        rect(header);
        const pane = value.panes[index];
        rect(pane);
        aligned(header.height, 44, "Header height");
        aligned(header.y, value.paneTop, "Header top");
        aligned(header.x, pane.x, "Header left");
        aligned(header.width, pane.width, "Header width");
      }
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
      assert.equal(value.services, 20, "Drag probe must exercise 20 services");
      assert.equal(value.appRegion, "drag", "Drag row is not draggable");
      rect(value.region);
      aligned(value.region.height, 44, "Drag must be on the first row");
      assert(Array.isArray(value.targets), "Drag targets missing");
      for (const target of value.targets) rect(target);
      const span = dragSpan(value.region, value.targets);
      assert(span >= 48, `Drag area is ${span} px, below 48`);
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
