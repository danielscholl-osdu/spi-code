// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { type ViewSnapshot, ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import november6 from "../../../../../fixtures/watch/snapshot-1106.json?raw";
import { closeSheet } from "../../app/navigation.js";
import { Shell } from "../../app/Shell.js";
import { selectionStore } from "../../panels/selection.js";
import { watchStore } from "../../store/watch.js";
import { clockTime } from "../../time.js";
import { midSweep } from "../sweep/test-helper.js";

// Stubbed layout for the November 6 sweep: 13 pips are 153 px full and 102 px small, the gap is
// 14 px. Unfolded the row needs 1028 px, with stopped as a count 878, with small pips 827; wrapped
// from due on, the first row needs 469 and the second 344. Every level also keeps 48 px to drag.
const WIDTHS: Record<string, number> = {
  "stopped.names": 216,
  "stopped.count": 66,
  "environment.full": 158,
  "environment.version": 80,
  template: 101,
  "due.full": 130,
  "due.count": 37,
  "next-sync": 108,
  freshness: 78,
};
const SECOND_PADDING = 26;

const fixture = () => ViewSnapshotSchema.parse(JSON.parse(november6));
const previousWatch = watchStore.getState();
const previousSpi = window.spi;
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
    ? [...(strip()?.children ?? [])].filter((node) => node.matches("[data-field], .strip-pips"))
    : [...(strip()?.querySelector('[data-strip-row="second"]')?.children ?? [])];
const names = (row: "first" | "second") =>
  rowOf(row).map((node) => (node as HTMLElement).dataset.field ?? "pips");
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (Macintosh; Mac OS X) Electron/44.10.0",
  );
  closeSheet();
  window.location.hash = "#today";
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    setAppearance: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  selectionStore.getState().clear();
  selectionStore.getState().setOpen(false);
  layout = { first: 900, second: 1000, widths: { ...WIDTHS } };
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
  window.spi = previousSpi;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("folds stopped to a count and shrinks the pips before it wraps, keeping one 44 px row", async () => {
  await mount();
  expect(strip()?.dataset.rows).toBe("1");
  expect(strip()?.dataset.pips).toBe("small");
  expect(field("stopped")?.textContent).toBe("1 stopped");
  expect(field("stopped")?.title).toBe("entitlements stopped");
  expect(names("second")).toEqual([]);
  const mark = strip()?.querySelector<HTMLElement>(".strip-pip-mark:not([data-shape=diamond])");
  if (!mark) throw new Error("Missing pip mark");
  expect(getComputedStyle(mark).width).toBe("6px");
  expect(topbar()).toBe("44px");
});

it("wraps at once when a field's content overflows the first row", async () => {
  await mount();
  await relayout({ widths: { ...layout.widths, "environment.full": 360 } });
  expect(strip()?.dataset.rows).toBe("2");
  expect(names("first")).toEqual(["pips", "stopped", "environment", "template"]);
  expect(names("second")).toEqual(["due", "next-sync", "freshness"]);
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
  await relayout({ first: 898 });
  expect(strip()?.dataset.rows).toBe("2");
  await relayout({ first: 899 });
  expect(strip()?.dataset.rows).toBe("1");
  expect(names("first")).toEqual([
    "pips",
    "stopped",
    "environment",
    "template",
    "due",
    "next-sync",
    "freshness",
  ]);
  expect(topbar()).toBe("44px");
});

it.each([
  ["refresh, then resize", 899, "1"],
  ["resize, then refresh", 899, "1"],
  ["refresh, then resize", 898, "2"],
  ["resize, then refresh", 898, "2"],
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

it("shortens the second row's fields and keeps their full text on hover", async () => {
  const body = fixture();
  const nextSync = body.briefing.nextSyncAt as string;
  layout = { ...layout, first: 240, second: 520 };
  await mount();
  expect(names("first")).toEqual(["pips", "stopped"]);
  expect(names("second")).toEqual(["environment", "template", "due", "next-sync", "freshness"]);
  expect(field("environment")?.textContent).toBe("env v0.35.3");
  expect(field("environment")?.title).toBe("env v0.35.3 deployable");
  expect(field("due")?.textContent).toBe("10 due");
  expect(field("due")?.title).toBe(`10 due before ${clockTime(nextSync)}`);
  expect(field("stopped")?.title).toBe("entitlements stopped");
});

it("shows every field in full with no titles added when the row has room", async () => {
  layout = { ...layout, first: 1200 };
  await mount();
  expect(strip()?.dataset.pips).toBe("full");
  expect(field("stopped")?.textContent).toBe("entitlements stopped");
  expect(field("stopped")?.hasAttribute("title")).toBe(false);
  expect(field("environment")?.hasAttribute("title")).toBe(false);
  expect(field("due")?.hasAttribute("title")).toBe(false);
});

it("names each folded field with its unfolded text", async () => {
  const name = (field: string) => {
    const node = strip()?.querySelector<HTMLElement>(`[data-field="${field}"]`);
    return node?.getAttribute("aria-label") ?? node?.textContent;
  };
  const folded = ["stopped", "environment", "due"];
  layout = { ...layout, first: 1200 };
  await mount();
  const unfolded = folded.map(name);
  expect(unfolded.every((text) => text && !field("stopped")?.hasAttribute("aria-label"))).toBe(
    true,
  );
  await relayout({ first: 240, second: 520 });
  expect(folded.map((name) => field(name)?.textContent)).toEqual([
    "1 stopped",
    "env v0.35.3",
    "10 due",
  ]);
  expect(folded.map(name)).toEqual(unfolded);
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
  expect(names("second")).toEqual(["due", "next-sync", "freshness"]);
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
