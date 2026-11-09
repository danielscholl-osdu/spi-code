// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { assertSmokeGeometry, type SmokeGeometry } from "./smoke-geometry.js";

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

const related: SmokeGeometry = {
  rule: "related",
  panel: rect(1160, 75, 280, 725),
  label: rect(1184, 300, 232, 54),
  labelText: "A deliberately long Related label that wraps over multiple lines at 280 px",
  values: [rect(1184, 356, 232, 42), rect(1184, 420, 232, 42)],
};
const panes: SmokeGeometry = {
  rule: "panes",
  panes: [
    { rect: rect(0, 75, 232, 725), borderLeft: 0, borderRight: 1 },
    { rect: rect(232, 75, 568, 725), borderLeft: 0, borderRight: 0 },
    { rect: rect(800, 75, 360, 725), borderLeft: 1, borderRight: 0 },
    { rect: rect(1160, 75, 280, 725), borderLeft: 1, borderRight: 0 },
  ],
};
const headers: SmokeGeometry = {
  rule: "headers",
  paneTop: 75,
  headers: [rect(232, 75, 568, 44), rect(800, 75, 360, 44), rect(1160, 75, 280, 44)],
};
const settings: SmokeGeometry = {
  rule: "settings",
  viewport: rect(0, 0, 740, 800),
  dialog: rect(24, 120, 692, 560),
};
const drag: SmokeGeometry = {
  rule: "drag",
  services: 20,
  appRegion: "drag",
  region: rect(84, 0, 648, 44),
  targets: [rect(84, 0, 500, 44), rect(632, 0, 100, 44)],
};

it.each([related, panes, headers, settings, drag])("accepts measured $rule geometry", (value) => {
  expect(() => assertSmokeGeometry(value)).not.toThrow();
});

it.each([
  { ...related, values: [rect(1184, 356, 159.99, 42)] },
  { ...related, panel: rect(1160, 75, 281, 725) },
  { ...related, label: rect(1184, 356, 232, 54) },
  { ...related, values: [] },
  { ...related, labelText: "Short" },
])("fails a squeezed or unexercised Related rule: %j", (value) => {
  expect(() => assertSmokeGeometry(value)).toThrow(/Related/);
});

it("fails pane gaps, rounded frames and dividers other than 1 px", () => {
  for (const change of [
    { rect: rect(801, 75, 359, 725) },
    { rect: rect(800, 76, 360, 724) },
    { borderLeft: 0 },
    { borderLeft: 2 },
  ]) {
    expect(() =>
      assertSmokeGeometry({
        ...panes,
        panes: panes.panes.map((pane, index) => (index === 2 ? { ...pane, ...change } : pane)),
      }),
    ).toThrow(/Pane/);
  }
});

it("fails a wrong header height or top, including three equally displaced headers", () => {
  for (const changed of [
    [rect(232, 75, 568, 43), ...headers.headers.slice(1)],
    [rect(232, 76, 568, 44), ...headers.headers.slice(1)],
    headers.headers.map((header) => ({ ...header, y: 76 })),
  ]) {
    expect(() => assertSmokeGeometry({ ...headers, headers: changed })).toThrow(/Header/);
  }
});

it.each([
  rect(24, 120, 693, 560),
  rect(24, 120, 692, 561),
  rect(23, 120, 692, 560),
  rect(24, 23, 692, 560),
  rect(24, 217, 692, 560),
])("fails an oversized dialog or any edge below 24 px: %j", (dialog) => {
  expect(() => assertSmokeGeometry({ ...settings, dialog })).toThrow(/Settings/);
});

it("accepts the wide Settings maximum and rejects a wider dialog", () => {
  const wide = { ...settings, viewport: rect(0, 0, 1440, 800), dialog: rect(310, 120, 820, 560) };
  expect(() => assertSmokeGeometry(wide)).not.toThrow();
  expect(() => assertSmokeGeometry({ ...wide, dialog: rect(310, 120, 821, 560) })).toThrow();
});

it("requires a contiguous 48 px drag span, not a sum of smaller gaps or space on row two", () => {
  expect(() =>
    assertSmokeGeometry({ ...drag, targets: [rect(84, 0, 501, 44), drag.targets[1]] }),
  ).toThrow(/Drag/);
  expect(() =>
    assertSmokeGeometry({
      ...drag,
      targets: [rect(108, 0, 288, 44), rect(420, 0, 288, 44)],
    }),
  ).toThrow(/Drag/);
  expect(() =>
    assertSmokeGeometry({ ...drag, targets: [...drag.targets, rect(584, 44, 48, 31)] }),
  ).not.toThrow();
  expect(() => assertSmokeGeometry({ ...drag, appRegion: "no-drag" })).toThrow(/Drag/);
  expect(() => assertSmokeGeometry({ ...drag, services: 13 })).toThrow(/20 services/);
});

it("rejects absent, unknown and non-finite geometry rather than passing an empty probe", () => {
  for (const value of [
    undefined,
    {},
    { rule: "unknown" },
    { ...settings, dialog: { ...settings.dialog, width: NaN } },
  ]) {
    expect(() => assertSmokeGeometry(value)).toThrow();
  }
});
