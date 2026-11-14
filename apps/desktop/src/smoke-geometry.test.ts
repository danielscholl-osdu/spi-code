// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it, vi } from "vitest";
import { assertSmokeGeometry, type SmokeGeometry, type SmokeRect } from "./smoke-geometry.js";

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
});

const releasePlatform: SmokeGeometry = {
  rule: "release-platform",
  platform: rect(24, 1000, 676, 80),
  versions: 2,
  library: {
    bounds: rect(120, 1020, 400, 50),
    bar: rect(210, 1020, 170, 10),
    segments: [rect(210, 1020, 80, 10), rect(292, 1020, 88, 10)],
    counts: rect(210, 1034, 200, 32),
    text: [rect(210, 1034, 190, 14), rect(210, 1050, 100, 14)],
  },
};

it("accepts library counts beside the bar or wrapped below it, and an absent distribution", () => {
  expect(() => assertSmokeGeometry(releasePlatform)).not.toThrow();
  expect(() =>
    assertSmokeGeometry({
      ...releasePlatform,
      library: {
        ...releasePlatform.library,
        counts: rect(388, 1020, 120, 16),
        text: [rect(388, 1020, 120, 14)],
      },
    }),
  ).not.toThrow();
  expect(() =>
    assertSmokeGeometry({ ...releasePlatform, versions: 0, library: null }),
  ).not.toThrow();
});

it("rejects overlapping library counts, overflowing segments and clipped count text", () => {
  for (const change of [
    { counts: rect(370, 1020, 120, 16), text: [rect(370, 1020, 120, 14)] },
    { segments: [rect(210, 1020, 80, 10), rect(292, 1020, 100, 10)] },
    { bounds: rect(120, 1020, 250, 50) },
    { text: [rect(210, 1034, 201, 14)] },
    { bounds: rect(120, 1020, 600, 50) },
    { counts: rect(210, 1000, 120, 16), text: [rect(210, 1000, 120, 14)] },
  ])
    expect(() =>
      assertSmokeGeometry({
        ...releasePlatform,
        library: { ...releasePlatform.library, ...change },
      }),
    ).toThrow(/Library/);
});

it("rejects missing library geometry when the fixture carries a distribution", () => {
  for (const library of [
    null,
    { ...releasePlatform.library, segments: [] },
    { ...releasePlatform.library, text: [] },
  ])
    expect(() => assertSmokeGeometry({ ...releasePlatform, library })).toThrow();
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
    { rect: rect(0, 0, 232, 800), borderLeft: 0, borderRight: 1 },
    { rect: rect(232, 0, 568, 800), borderLeft: 0, borderRight: 0 },
    { rect: rect(800, 0, 360, 800), borderLeft: 1, borderRight: 0 },
    { rect: rect(1160, 0, 280, 800), borderLeft: 1, borderRight: 0 },
  ],
};
const headerPanes = [
  rect(0, 0, 231, 800),
  rect(232, 0, 568, 800),
  rect(801, 0, 359, 800),
  rect(1161, 0, 279, 800),
];
const headers: SmokeGeometry = {
  rule: "headers",
  panes: headerPanes,
  headers: headerPanes.map((pane, index) => ({
    rect: { ...pane, height: 44 },
    rule: index === 0 ? 0 : 1,
  })),
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
const sidebarToggle = { label: "Toggle sidebar", rect: rect(76, 8, 28, 28) };
const capsule = { label: "Line", rect: rect(400, 8, 240, 28) };
const closeDetail = { label: "Close detail", rect: rect(1260, 8, 28, 28) };
const drag: SmokeGeometry = {
  rule: "drag",
  services: 20,
  controls: "overlay",
  clear: rect(0, 0, 1302, 44),
  viewport: rect(0, 0, 1440, 800),
  centre: rect(232, 0, 568, 44),
  capsule: capsule.rect,
  detailSheet: false,
  regions: [
    { appRegion: "no-drag", rect: sidebarToggle.rect },
    { appRegion: "drag", rect: rect(0, 0, 231, 44) },
    { appRegion: "no-drag", rect: sidebarToggle.rect },
    { appRegion: "drag", rect: rect(232, 0, 568, 44) },
    { appRegion: "no-drag", rect: capsule.rect },
    { appRegion: "drag", rect: rect(1161, 0, 279, 44) },
    { appRegion: "no-drag", rect: closeDetail.rect },
  ],
  targets: [sidebarToggle, capsule, closeDetail],
};
const failedReads: SmokeGeometry = {
  rule: "failed-reads",
  section: rect(1101, 650, 323, 52),
  panel: rect(1084, 88, 356, 712),
  rows: [
    { source: "GitHub issues and PRs", outcome: "read failed · unit, crs-catalog, crs-conversion" },
  ],
};
const sweepVisible: SmokeGeometry = {
  rule: "sweep-visible",
  viewport: rect(0, 0, 740, 800),
  panel: rect(380, 88, 360, 712),
  elements: [rect(396, 120, 328, 100), rect(396, 150, 150, 40), rect(560, 120, 140, 30)],
};
const sweepReads: SmokeGeometry = {
  rule: "sweep-reads",
  width: 740,
  picker: "Sweep",
  rows: Array.from({ length: 4 }, (_, index) => ({
    name: rect(42, 300 + index * 64, 656, 24),
    cadence: rect(42, 328 + index * 64, 120, 18),
    lastRead: rect(580, 328 + index * 64, 118, 18),
    label: "last read",
  })),
};

it("rejects a named sweep header or control scrolled out of its panel or viewport", () => {
  expect(() => assertSmokeGeometry(sweepVisible)).not.toThrow();
  for (const bounds of [rect(396, 60, 328, 100), rect(396, 750, 328, 100)]) {
    expect(() =>
      assertSmokeGeometry({
        ...sweepVisible,
        elements: [bounds, ...sweepVisible.elements.slice(1)],
      }),
    ).toThrow("Sweep element outside");
  }
  expect(() => assertSmokeGeometry({ ...sweepVisible, panel: rect(380, -20, 360, 820) })).toThrow(
    "Sweep panel outside viewport",
  );
  expect(() => assertSmokeGeometry({ ...sweepVisible, elements: [] })).toThrow();
});

it("requires the Sweep picker and every last-read cell below its source at 740 px", () => {
  expect(() => assertSmokeGeometry(sweepReads)).not.toThrow();
  expect(() => assertSmokeGeometry({ ...sweepReads, picker: "Readiness" })).toThrow("Sweep picker");
  for (const change of [
    { lastRead: rect(580, 300, 118, 18) },
    { cadence: rect(42, 300, 120, 18) },
    { label: "" },
  ]) {
    expect(() =>
      assertSmokeGeometry({
        ...sweepReads,
        rows: sweepReads.rows.map((row, index) => (index === 0 ? { ...row, ...change } : row)),
      }),
    ).toThrow(/Sweep/);
  }
  expect(() => assertSmokeGeometry({ ...sweepReads, rows: sweepReads.rows.slice(1) })).toThrow();
});

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
    { rect: rect(801, 0, 359, 800) },
    { rect: rect(800, 1, 360, 799) },
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

it("fails a header out of line with the top row, its pane or the shared rule", () => {
  const moved = (index: number, change: Partial<SmokeRect>, rule?: number) =>
    headers.headers.map((header, at) =>
      at === index ? { rect: { ...header.rect, ...change }, rule: rule ?? header.rule } : header,
    );
  for (const [changed, message] of [
    [moved(3, { y: 4 }), "Header top: 4 != 0"],
    [moved(1, { height: 43 }), "Header height"],
    [moved(2, { width: 345 }), "Header width"],
    [moved(0, { x: 15 }), "Header left"],
    [moved(2, {}, 2), "Header rule"],
    [
      headers.headers.map((header) => ({ ...header, rule: 0 })),
      "Header probe found no bottom rule",
    ],
  ] as const)
    expect(() => assertSmokeGeometry({ ...headers, headers: changed })).toThrow(message);
  expect(() =>
    assertSmokeGeometry({
      ...headers,
      panes: headers.panes.map((pane) => ({ ...pane, y: 75 })),
      headers: headers.headers.map((header) => ({ ...header, rect: { ...header.rect, y: 75 } })),
    }),
  ).toThrow("Pane top");
});

it("checks the same header rules with fewer panes shown", () => {
  for (const count of [1, 2]) {
    const probe = {
      ...headers,
      panes: headers.panes.slice(1, 1 + count),
      headers: headers.headers.slice(1, 1 + count),
    };
    expect(() => assertSmokeGeometry(probe)).not.toThrow();
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

it("accepts one top row with both toggles clear of the caption buttons", () => {
  expect(() => assertSmokeGeometry(drag)).not.toThrow();
  expect(() =>
    assertSmokeGeometry({
      ...drag,
      controls: "inset",
      clear: rect(0, 0, 1440, 44),
      detailSheet: true,
      targets: [sidebarToggle, capsule],
    }),
  ).not.toThrow();
});

it("fails a top-row control in a drag rectangle, under the caption buttons or off the row", () => {
  expect(() =>
    assertSmokeGeometry({ ...drag, regions: drag.regions.filter((_, index) => index !== 2) }),
  ).toThrow("Toggle sidebar at 76,8 28x28 lies in a drag rectangle");
  const under = { label: "Close detail", rect: rect(1300, 8, 28, 28) };
  expect(() => assertSmokeGeometry({ ...drag, targets: [sidebarToggle, capsule, under] })).toThrow(
    "Top row target under the window controls: Close detail at 1300,8 28x28",
  );
  expect(() =>
    assertSmokeGeometry({
      ...drag,
      targets: [{ ...sidebarToggle, rect: rect(76, 30, 28, 28) }, capsule, closeDetail],
    }),
  ).toThrow("Top row target off the row");
  expect(() => assertSmokeGeometry({ ...drag, clear: rect(0, 0, 1440, 44) })).toThrow(
    "Caption buttons not reported",
  );
});

it("needs exactly one toggle for the sidebar and one for the right panel", () => {
  expect(() => assertSmokeGeometry({ ...drag, targets: [capsule, closeDetail] })).toThrow(
    "one sidebar toggle",
  );
  expect(() =>
    assertSmokeGeometry({ ...drag, targets: [sidebarToggle, sidebarToggle, capsule, closeDetail] }),
  ).toThrow("one sidebar toggle");
  expect(() => assertSmokeGeometry({ ...drag, targets: [sidebarToggle, capsule] })).toThrow(
    "one right-panel toggle",
  );
  expect(() => assertSmokeGeometry({ ...drag, detailSheet: true })).toThrow(
    "one right-panel toggle",
  );
});

it("centres the capsule on the centre's header once the centre is 1000 px wide", () => {
  const hidden = (width: number, capsule: SmokeRect) => {
    const openDetail = { label: "Toggle right panel", rect: rect(width - 38, 8, 28, 28) };
    return {
      ...drag,
      controls: "inset" as const,
      clear: rect(0, 0, width, 44),
      viewport: rect(0, 0, width, 800),
      centre: rect(0, 0, width, 44),
      capsule,
      regions: [
        { appRegion: "no-drag" as const, rect: sidebarToggle.rect },
        { appRegion: "drag" as const, rect: rect(0, 0, width, 44) },
        { appRegion: "no-drag" as const, rect: rect(76, 0, 28, 43) },
        { appRegion: "no-drag" as const, rect: capsule },
        { appRegion: "no-drag" as const, rect: openDetail.rect },
      ],
      targets: [sidebarToggle, { label: "Line", rect: capsule }, openDetail],
    };
  };
  for (const [width, centred, old] of [
    [1000, 500, 551],
    [1280, 640, 691],
    [1440, 720, 771],
  ] as const) {
    expect(() => assertSmokeGeometry(hidden(width, rect(centred - 240, 8, 480, 28)))).not.toThrow();
    expect(() => assertSmokeGeometry(hidden(width, rect(old - 240, 8, 480, 28)))).toThrow(
      `Capsule midpoint ${old} is not the centre header's ${centred}`,
    );
  }
  expect(() => assertSmokeGeometry(hidden(1440, rect(481, 8, 480, 28)))).not.toThrow();
  expect(() => assertSmokeGeometry(hidden(1440, rect(482, 8, 480, 28)))).toThrow(
    "Capsule midpoint",
  );
  expect(() => assertSmokeGeometry(hidden(999, rect(500, 8, 480, 28)))).not.toThrow();
});

it("requires a contiguous 48 px drag span in the centre, not a sum of smaller gaps", () => {
  const crowded = (...middle: SmokeRect[]) => ({
    ...drag,
    regions: [...drag.regions, ...middle.map((rect) => ({ appRegion: "no-drag" as const, rect }))],
    targets: [sidebarToggle, ...middle.map((rect) => ({ label: "Line", rect })), closeDetail],
  });
  expect(() => assertSmokeGeometry(crowded(rect(232, 8, 521, 28)))).toThrow(
    "Drag area is 47 px, below 48",
  );
  expect(() =>
    assertSmokeGeometry(
      crowded(rect(232, 8, 200, 28), rect(479, 8, 200, 28), rect(726, 8, 74, 28)),
    ),
  ).toThrow(/Drag area/);
  expect(() => assertSmokeGeometry(crowded(rect(232, 8, 520, 28)))).not.toThrow();
  expect(() =>
    assertSmokeGeometry({
      ...drag,
      regions: drag.regions.filter((region) => region.rect.x !== 232),
    }),
  ).toThrow("is not a drag rectangle");
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
