// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import type { ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { closeSheet } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { clockTime } from "../../time.js";
import { midSweep } from "../sweep/test-helper.js";

// Stubbed layout for the November 6 sweep, the gap 14 px: unfolded the row needs 608 px; wrapped
// from next sync on, the first row needs 394, and 345 with Environment shortened to Env. Every
// level keeps 48 px to drag.
const WIDTHS: Record<string, number> = {
  "environment.full": 131,
  "environment.short": 82,
  template: 130,
  forks: 105,
  "next-sync": 108,
  freshness: 78,
};
/** "Environment Maintenance · refresh running" and its "Env" form. */
const LONG_ENVIRONMENT = { "environment.full": 280, "environment.short": 230 };
const SECOND_PADDING = 26;

const loadFixture = fixtureLoader(readFixture);
const fixture = () => loadFixture("snapshot-1106.json");
const previousWatch = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let unmount: (() => Promise<void>) | undefined;
let layout: { first: number; second: number; widths: Record<string, number> };
let observers: Map<ResizeObserverCallback, Set<Element>>;

function show(body: ViewSnapshot) {
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
}

function rect(width: number, height = 0): DOMRect {
  return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height } as DOMRect;
}

function fire() {
  for (const [callback, targets] of observers) {
    callback(
      [...targets].map((target) => ({ target }) as ResizeObserverEntry),
      {} as never,
    );
  }
}

/** Fires every observer, then again for what that layout changed, as the browser does. */
async function settle() {
  for (const _pass of [1, 2]) await act(async () => fire());
}

async function relayout(change: Partial<typeof layout>) {
  layout = { ...layout, ...change };
  await settle();
}

async function mount() {
  const style = document.createElement("style");
  style.textContent = [
    readFileSync("apps/window/src/style.css", "utf8"),
    readFileSync("apps/window/src/components/strip/strip.css", "utf8"),
  ].join("\n");
  document.head.append(style);
  container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  await settle();
  unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
    style.remove();
  };
}

const strip = () => container.querySelector<HTMLElement>(".window-strip [data-strip]");
const rowOf = (row: "first" | "second") =>
  row === "first"
    ? [...(strip()?.children ?? [])].filter((node) => node.matches("[data-field]"))
    : [...(strip()?.querySelector('[data-strip-row="second"]')?.children ?? [])];
const names = (row: "first" | "second") =>
  rowOf(row).map((node) => (node as HTMLElement).dataset.field);
const ORDER = ["environment", "template", "forks", "next-sync", "freshness"];
const label = (name: string) => field(name)?.firstChild?.textContent;
const field = (name: string) => strip()?.querySelector<HTMLElement>(`[data-field="${name}"]`);
/** happy-dom does not re-match :has() when a descendant changes until the element itself does. */
function heightOf(element: HTMLElement) {
  element.toggleAttribute("data-restyle");
  element.toggleAttribute("data-restyle");
  return getComputedStyle(element).height;
}
const topbar = () =>
  container.querySelector<HTMLElement>(".shell")?.style.getPropertyValue("--topbar-height");

beforeEach(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Mac OS X) Electron/44.10.0",
  );
  closeSheet();
  window.location.hash = "#today";
  harness = installSpi();
  selectionStore.getState().clear();
  selectionStore.getState().setOpen(false);
  layout = { first: 760, second: 1000, widths: { ...WIDTHS } };
  observers = new Map();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        observers.set(callback, this.targets);
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches(".title-bar")) return rect(1200, Number.parseFloat(heightOf(this)));
    if (this.matches(".strip")) return rect(layout.first, 44);
    if (this.matches('[data-strip-row="second"]')) return rect(layout.second + SECOND_PADDING);
    const name = this.dataset.measure ?? this.dataset.field;
    return rect((name ? layout.widths[name] : undefined) ?? 0);
  });
  show(fixture());
});

afterEach(async () => {
  await unmount?.();
  unmount = undefined;
  closeSheet();
  watchStore.setState(previousWatch, true);
  harness.restore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([1440, 740])("keeps next sync without a due field at %i px", async (width) => {
  const previousWidth = window.innerWidth;
  try {
    window.innerWidth = width;
    layout = { ...layout, first: width - 208, second: width - SECOND_PADDING };
    const body = fixture();
    expect([...body.briefing.focus, ...body.briefing.rest].some((item) => item.due)).toBe(true);
    await mount();
    expect(field("next-sync")?.textContent).toBe(
      `next sync ${clockTime(body.briefing.nextSyncAt as string)}`,
    );
    expect(field("due")).toBeNull();
    expect(strip()?.querySelector('[data-measure^="due"]')).toBeNull();
    expect(strip()?.textContent).not.toMatch(/\d+ due/);
    expect([...names("first"), ...names("second")]).toEqual(ORDER);
  } finally {
    window.innerWidth = previousWidth;
  }
});

it("wraps next sync and freshness first, keeping the Environment label", async () => {
  layout = { ...layout, first: 532 };
  await mount();
  expect(strip()?.dataset.rows).toBe("2");
  expect(names("first")).toEqual(["environment", "template", "forks"]);
  expect(names("second")).toEqual(["next-sync", "freshness"]);
  expect(label("environment")).toBe("Environment");
  expect(topbar()).toBe("75px");
});

it("shortens the Environment label to Env before Forks wraps, keeping the full name in its hover", async () => {
  layout = { ...layout, first: 560, widths: { ...layout.widths, ...LONG_ENVIRONMENT } };
  await mount();
  expect(names("first")).toEqual(["environment", "template", "forks"]);
  expect(names("second")).toEqual(["next-sync", "freshness"]);
  expect(label("environment")).toBe("Env");
  expect(field("environment")?.title).toMatch(/^Environment: Ready\./);
  expect(field("environment")?.getAttribute("aria-label")).toBe(field("environment")?.title);
});

it.each([
  [500, ["environment", "template"], ["forks", "next-sync", "freshness"]],
  [300, ["environment"], ["template", "forks", "next-sync", "freshness"]],
  [200, [], ORDER],
])("at a %i px row wraps a run from the end in reading order", async (first, top, second) => {
  layout = { ...layout, first, widths: { ...layout.widths, ...LONG_ENVIRONMENT } };
  await mount();
  expect(names("first")).toEqual(top);
  expect(names("second")).toEqual(second);
  expect(label("environment")).toBe("Env");
  expect(strip()?.dataset.rows).toBe("2");
});

it("wraps at once when a field's content overflows the first row", async () => {
  await mount();
  await relayout({ widths: { ...layout.widths, "environment.full": 360 } });
  expect(strip()?.dataset.rows).toBe("2");
  expect(names("first")).toEqual(["environment", "template", "forks"]);
  expect(names("second")).toEqual(["next-sync", "freshness"]);
  const second = strip()?.querySelector<HTMLElement>('[data-strip-row="second"]');
  if (!second) throw new Error("Missing second row");
  expect(getComputedStyle(second).height).toBe("31px");
  const title = container.querySelector<HTMLElement>(".title-bar");
  if (!title) throw new Error("Missing top row");
  expect(heightOf(title)).toBe("75px");
  expect(topbar()).toBe("75px");
});

it("stays wrapped when a refresh of the same sweep shrinks the content", async () => {
  await mount();
  await relayout({ widths: { ...layout.widths, "environment.full": 360 } });
  layout.widths["environment.full"] = WIDTHS["environment.full"] as number;
  await act(async () => show({ ...fixture() }));
  await settle();
  expect(strip()?.dataset.rows).toBe("2");
  expect(topbar()).toBe("75px");
});

it("unwraps on a resize only with 24 px to spare beyond the drag area", async () => {
  await mount();
  await relayout({ widths: { ...layout.widths, "environment.full": 360 } });
  layout.widths["environment.full"] = WIDTHS["environment.full"] as number;
  await relayout({ first: 679 });
  expect(strip()?.dataset.rows).toBe("2");
  await relayout({ first: 680 });
  expect(strip()?.dataset.rows).toBe("1");
  expect(names("first")).toEqual(ORDER);
  expect(topbar()).toBe("44px");
});

it.each([
  ["refresh, then resize", 680, "1"],
  ["resize, then refresh", 680, "1"],
  ["refresh, then resize", 679, "2"],
  ["resize, then refresh", 679, "2"],
])("a %s of the same sweep to %i px leaves %s row(s)", async (order, first, rows) => {
  await mount();
  await relayout({ widths: { ...layout.widths, "environment.full": 360 } });
  layout.widths["environment.full"] = WIDTHS["environment.full"] as number;
  // The window has resized before either lands; whichever runs first measures the new width.
  layout.first = first;
  const refresh = () => act(async () => show({ ...fixture() }));
  const resize = () => act(async () => fire());
  for (const step of order.startsWith("refresh") ? [refresh, resize] : [resize, refresh]) {
    await step();
  }
  await settle();
  expect(strip()?.dataset.rows).toBe(rows);
});

it("unwraps on a new sweep with slack", async () => {
  await mount();
  await relayout({ widths: { ...layout.widths, "environment.full": 360 } });
  layout.widths["environment.full"] = WIDTHS["environment.full"] as number;
  const body = fixture();
  await act(async () =>
    show({ ...body, sweptAt: new Date(Date.parse(body.sweptAt) + 60_000).toISOString() }),
  );
  await settle();
  expect(strip()?.dataset.rows).toBe("1");
  expect(topbar()).toBe("44px");
});

it("shows every field in full on one row when the row has room", async () => {
  layout = { ...layout, first: 1200 };
  await mount();
  expect(strip()?.dataset.rows).toBe("1");
  expect(names("first")).toEqual(ORDER);
  expect(label("environment")).toBe("Environment");
});

it("keeps each state field's accessible name as the row folds and wraps", async () => {
  const named = () =>
    ["environment", "template", "forks"].map((name) => field(name)?.getAttribute("aria-label"));
  layout = { ...layout, first: 1200 };
  await mount();
  const unfolded = named();
  expect(unfolded.every(Boolean)).toBe(true);
  await relayout({ first: 240, second: 420 });
  expect(names("second")).toEqual(["template", "forks", "next-sync", "freshness"]);
  expect(label("environment")).toBe("Env");
  expect(named()).toEqual(unfolded);
});

it("wraps a later sweep's longer freshness label to the second row like any other field", async () => {
  const body = fixture();
  await mount();
  expect(strip()?.dataset.rows).toBe("1");
  await act(async () => watchStore.setState({ progress: midSweep({ first: false }) }));
  expect(field("freshness")?.querySelector("[data-sweep-display]")?.textContent).toBe(
    `${clockTime(body.sweptAt)} · sweeping 9 of 12`,
  );
  await relayout({ widths: { ...layout.widths, freshness: 190 } });
  expect(strip()?.dataset.rows).toBe("2");
  expect(names("second")).toEqual(["next-sync", "freshness"]);
  expect(field("freshness")?.title).toBe(
    `Swept ${clockTime(body.sweptAt)} · sweeping, 9 of 12 sources done`,
  );
  expect(topbar()).toBe("75px");
});

it("lets the fold plan, not the window width, shorten the first sweep's count", async () => {
  const width = window.innerWidth;
  try {
    window.innerWidth = 899;
    watchStore.setState({ snapshot: null, progress: midSweep() });
    layout = {
      ...layout,
      first: 640,
      widths: { ...layout.widths, "freshness.full": 121, "freshness.short": 55 },
    };
    await mount();
    const shown = () => field("freshness")?.querySelector("[data-sweep-display]")?.textContent;
    expect(shown()).toBe("sweeping · 9 of 12");
    await relayout({ first: 150 });
    expect(shown()).toBe("9 of 12");
    expect(field("freshness")?.title).toBe("First sweep · 9 of 12 sources done");
    expect(strip()?.dataset.rows).toBeUndefined();
    await relayout({ first: 640 });
    expect(shown()).toBe("sweeping · 9 of 12");
  } finally {
    window.innerWidth = width;
  }
});

it("shortens the first sweep's count in the narrow layout, where the sidebar leaves the row", async () => {
  const width = window.innerWidth;
  const resize = async (to: number, first: number) => {
    window.innerWidth = to;
    layout = { ...layout, first };
    await act(async () => window.dispatchEvent(new Event("resize")));
    await settle();
  };
  try {
    window.innerWidth = 740;
    watchStore.setState({ snapshot: null, progress: midSweep() });
    layout = {
      ...layout,
      first: 574,
      widths: { ...layout.widths, "freshness.full": 121, "freshness.short": 55 },
    };
    await mount();
    const shown = () => field("freshness")?.querySelector("[data-sweep-display]")?.textContent;
    expect(container.querySelector(".shell")?.getAttribute("data-layout")).toBe("narrow");
    expect(shown()).toBe("9 of 12");
    expect(field("freshness")?.title).toBe("First sweep · 9 of 12 sources done");
    await resize(900, 734);
    expect(shown()).toBe("sweeping · 9 of 12");
    await resize(740, 574);
    expect(shown()).toBe("9 of 12");
  } finally {
    window.innerWidth = width;
  }
});

it.each(["failed", "cancelled"] as const)(
  "shortens a %s first sweep to stopped at 740 px, retaining its full name and failed tone",
  async (outcome) => {
    const width = window.innerWidth;
    try {
      window.innerWidth = 740;
      watchStore.setState({
        snapshot: null,
        progress:
          outcome === "cancelled"
            ? midSweep({ outcome })
            : {
                ...midSweep(),
                outcome: "failed",
                code: "timeout",
                failure: "GitHub did not answer in time.",
                nextAttemptAt: null,
              },
      });
      layout = {
        ...layout,
        first: 574,
        widths: { ...layout.widths, "freshness.full": 130, "freshness.short": 55 },
      };
      await mount();
      const shown = () => field("freshness")?.querySelector("[data-sweep-display]")?.textContent;
      expect(shown()).toBe("stopped");
      expect(field("freshness")?.title).toBe("first sweep stopped");
      expect(field("freshness")?.dataset.tone).toBe("bad");
      expect(field("freshness")?.querySelector(".evidence-dot")?.getAttribute("data-tone")).toBe(
        "bad",
      );
      window.innerWidth = 900;
      layout = { ...layout, first: 734 };
      await act(async () => window.dispatchEvent(new Event("resize")));
      await settle();
      expect(shown()).toBe("first sweep stopped");
      await act(async () => watchStore.setState({ progress: midSweep({ sweep: "sweep-2" }) }));
      await settle();
      expect(shown()).toBe("sweeping · 9 of 12");
      expect(field("freshness")?.dataset.tone).toBe("run");
    } finally {
      window.innerWidth = width;
    }
  },
);
