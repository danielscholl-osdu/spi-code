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
  | { rule: "drag"; services: number; appRegion: string; region: SmokeRect; targets: SmokeRect[] };

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

export function assertSmokeGeometry(value: unknown): asserts value is SmokeGeometry {
  record(value);
  switch (value.rule) {
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
        Array.isArray(value.headers) && value.headers.length === 3,
        "Header probe requires centre, Line and Detail",
      );
      assert(Array.isArray(value.panes) && value.panes.length === 3, "Header panes missing");
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
    default:
      assert.fail(`Unknown geometry rule: ${value.rule}`);
  }
}
