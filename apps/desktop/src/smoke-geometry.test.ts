// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it, vi } from "vitest";
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
  viewport: rect(0, 0, 1440, 800),
  scroll: { width: 1440, height: 800 },
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
  panes: panes.panes.slice(1).map((pane) => pane.rect),
  headers: [rect(232, 75, 568, 44), rect(800, 75, 360, 44), rect(1160, 75, 280, 44)],
};
const window: SmokeGeometry = {
  rule: "window",
  viewport: panes.viewport,
  scroll: panes.scroll,
  panes: panes.panes.map((pane) => pane.rect),
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
const failedReads: SmokeGeometry = {
  rule: "failed-reads",
  section: rect(1101, 650, 323, 52),
  panel: rect(1084, 88, 356, 712),
  rows: [
    { source: "GitHub issues and PRs", outcome: "read failed · unit, crs-catalog, crs-conversion" },
  ],
};

const titleBar = { appRegion: "drag" as const, rect: rect(0, 0, 740, 44) };
const settingsPopup = { appRegion: "no-drag" as const, rect: rect(24, 24, 692, 512) };
const overlayDrag: SmokeGeometry = {
  rule: "overlay-drag",
  overlay: "[role=dialog].settings",
  viewport: rect(0, 0, 740, 560),
  regions: [titleBar, { appRegion: "no-drag", rect: rect(700, 8, 28, 28) }, settingsPopup],
  targets: [{ label: "Close settings", rect: rect(684, 32, 24, 24) }],
};

it.each([window, related, panes, headers, settings, drag, failedReads, overlayDrag])(
  "accepts measured $rule geometry",
  (value) => {
    expect(() => assertSmokeGeometry(value)).not.toThrow();
  },
);

it("reports the quarter-pixel clipping reproduced at CI's 1x scale with the actual row text", () => {
  const clipped = { ...failedReads, section: { ...failedReads.section, y: 748.25 } };
  expect(() => assertSmokeGeometry(clipped)).toThrow(
    `Failed reads outside panel: ${JSON.stringify(clipped)}`,
  );
});

it("rejects incorrect failed-read wording after measurement instead of waiting for a DOM timeout", () => {
  const wrong = {
    ...failedReads,
    rows: [{ source: "GitHub issues and PRs", outcome: "core text or missing fleet ids" }],
  };
  expect(() => assertSmokeGeometry(wrong)).toThrow(`Failed-read wording: ${JSON.stringify(wrong)}`);
});

it("checks failed-read bounds and wording in UTC with a clock shifted 400 days", () => {
  vi.useFakeTimers();
  vi.stubEnv("TZ", "UTC");
  vi.setSystemTime(new Date(Date.parse("2026-11-06T15:04:00Z") + 400 * 86_400_000));
  try {
    expect(() => assertSmokeGeometry(failedReads)).not.toThrow();
    expect(() =>
      assertSmokeGeometry({ ...failedReads, rows: [{ ...failedReads.rows[0], outcome: "" }] }),
    ).toThrow(/Failed-read wording/);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

it("rejects a mutually flush pane row inset from any window edge", () => {
  for (const changed of [
    panes.panes.map((pane, index) => ({
      ...pane,
      rect: { ...pane.rect, x: pane.rect.x + 15, width: pane.rect.width - (index === 3 ? 15 : 0) },
    })),
    panes.panes.map((pane, index) => ({
      ...pane,
      rect: { ...pane.rect, width: pane.rect.width - (index === 3 ? 15 : 0) },
    })),
    panes.panes.map((pane) => ({ ...pane, rect: { ...pane.rect, height: 710 } })),
  ])
    expect(() => assertSmokeGeometry({ ...panes, panes: changed })).toThrow(/Pane row/);
});

it.each([
  { width: 1455, height: 800 },
  { width: 1440, height: 1057 },
])("rejects page overflow in either axis even when all panes fit: %j", (scroll) => {
  expect(() => assertSmokeGeometry({ ...panes, scroll })).toThrow(/Page scroll/);
  expect(() => assertSmokeGeometry({ ...window, scroll })).toThrow(/Page scroll/);
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
    headers.headers.map((header) => ({ ...header, width: header.width - 15 })),
    headers.headers.map((header) => ({ ...header, x: header.x + 15 })),
  ]) {
    expect(() => assertSmokeGeometry({ ...headers, headers: changed })).toThrow(/Header/);
  }
});

it("checks the same header rules on a first-sweep centre and an Evidence pane", () => {
  for (const count of [1, 2]) {
    const probe = {
      ...headers,
      panes: headers.panes.slice(0, count),
      headers: headers.headers.slice(0, count),
    };
    expect(() => assertSmokeGeometry(probe)).not.toThrow();
    expect(() =>
      assertSmokeGeometry({
        ...probe,
        headers: probe.headers.map((header) => ({ ...header, width: header.width - 15 })),
      }),
    ).toThrow("Header width");
    expect(() => assertSmokeGeometry({ ...probe, headers: [] })).toThrow("Header probe");
    expect(() => assertSmokeGeometry({ ...probe, panes: [] })).toThrow("Header panes");
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

it("rejects an overlay target the title bar's drag rectangle still covers", () => {
  const exposed = { ...overlayDrag, regions: overlayDrag.regions.slice(0, 2) };
  expect(() => assertSmokeGeometry(exposed)).toThrow(
    "[role=dialog].settings Close settings at 684,32 24x24 lies in a drag rectangle",
  );
  expect(() => assertSmokeGeometry({ ...overlayDrag, regions: [settingsPopup, titleBar] })).toThrow(
    /lies in a drag rectangle/,
  );
  expect(() =>
    assertSmokeGeometry({
      ...exposed,
      targets: [{ label: "Close settings", rect: rect(684, 44, 24, 24) }],
    }),
  ).not.toThrow();
  expect(() =>
    assertSmokeGeometry({
      ...exposed,
      regions: [...exposed.regions, { appRegion: "no-drag", rect: rect(684, 32, 12, 24) }],
    }),
  ).toThrow(/lies in a drag rectangle/);
  expect(() => assertSmokeGeometry({ ...overlayDrag, regions: [settingsPopup] })).toThrow(
    /no drag region/,
  );
  expect(() => assertSmokeGeometry({ ...overlayDrag, targets: [] })).toThrow(/no interactive/);
});

it("rejects an overlay backdrop whose title band the drag rectangle still covers", () => {
  const backdrop = rect(0, 0, 740, 560);
  const shaded = {
    ...overlayDrag,
    regions: [titleBar, { appRegion: "no-drag" as const, rect: backdrop }, settingsPopup],
    backdrop,
  };
  expect(() => assertSmokeGeometry(shaded)).not.toThrow();
  expect(() => assertSmokeGeometry({ ...shaded, regions: [titleBar, settingsPopup] })).toThrow(
    "[role=dialog].settings backdrop at 0,0 740x560 lies in a drag rectangle",
  );
  expect(() =>
    assertSmokeGeometry({
      ...shaded,
      regions: [titleBar, settingsPopup],
      backdrop: rect(0, 44, 740, 516),
    }),
  ).not.toThrow();
  expect(() => assertSmokeGeometry({ ...shaded, backdrop: rect(0, 0, NaN, 560) })).toThrow();
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
