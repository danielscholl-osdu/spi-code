// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFixture } from "../../../../scripts/watch-generated.mjs";
import { selectionStore } from "../panels/selection.js";
import { clearPinNotice } from "../store/pin-feedback.js";
import { PINS_STORAGE_KEY, readPins } from "../store/pins.js";
import { watchStore } from "../store/watch.js";
import { fixtureLoader, installSpi } from "../test-utils/harness.js";
import { closeSheet, navigate, type Route } from "./navigation.js";
import { Shell } from "./Shell.js";

const body = fixtureLoader(readFixture)("snapshot-59d6895.json");
const previous = watchStore.getState();
let harness: ReturnType<typeof installSpi>;
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  window.location.hash = "";
  closeSheet();
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(["place:upstream"]));
  harness = installSpi();
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Shell />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  closeSheet();
  selectionStore.getState().clear();
  watchStore.setState(previous);
  harness.restore();
  window.location.hash = "";
  vi.unstubAllGlobals();
  localStorage.removeItem(PINS_STORAGE_KEY);
  localStorage.removeItem("spi-code.line-sheet.pinned");
  localStorage.removeItem("spi-code.panes");
  localStorage.removeItem("spi-code.sidebar.collapsed");
  clearPinNotice();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const press = (key: string, init: KeyboardEventInit = { ctrlKey: true, shiftKey: true }) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
const go = (route: Route) => act(async () => navigate(route));
const control = () => container.querySelector<HTMLButtonElement>(".centre-end > .pin-control");
const stored = () => localStorage.getItem(PINS_STORAGE_KEY);

it("pins and unpins the place or service open in the centre", async () => {
  await go({ kind: "upstream" });
  expect(control()?.getAttribute("aria-label")).toBe("Unpin Upstream from sidebar (Ctrl+Shift+P)");
  await press("P");
  expect(readPins()).toEqual([]);
  expect(control()?.getAttribute("aria-label")).toBe("Pin Upstream to sidebar (Ctrl+Shift+P)");
  await go({ kind: "service", id: "legal" });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  await press("P");
  expect(readPins()).toEqual([]);
  await press("p", { metaKey: true, shiftKey: true });
  expect(readPins()).toEqual(["legal"]);
  expect(control()?.getAttribute("aria-label")).toBe("Unpin legal from sidebar (⌘⇧P)");
});

it("draws no control and does nothing on Today, a release month or a fixed place", async () => {
  const before = stored();
  for (const route of [
    { kind: "today" },
    { kind: "release", month: "2026-11" },
    { kind: "environment" },
    { kind: "engineering-system" },
  ] as const) {
    await go(route);
    expect(control()).toBeNull();
    await press("P");
    expect(stored()).toBe(before);
  }
});

it("does nothing while Settings is open or the Line sheet overlays the centre, and acts beside a docked one", async () => {
  await go({ kind: "releases" });
  await press(",", { ctrlKey: true });
  expect(document.querySelector("[role=dialog]")).not.toBeNull();
  await press("P");
  expect(readPins()).toEqual(["place:upstream"]);
  await press("Escape", {});
  expect(document.querySelector("[role=dialog]")).toBeNull();

  await press("l", { ctrlKey: true });
  expect(container.querySelector(".line-sheet")?.getAttribute("data-presentation")).toBe("overlay");
  await press("P");
  expect(readPins()).toEqual(["place:upstream"]);
  const dock = [...container.querySelectorAll<HTMLButtonElement>(".line-toolbar button")].find(
    (button) => button.textContent === "Dock",
  );
  await act(async () => dock?.click());
  await press("P");
  expect(readPins()).toEqual(["place:upstream", "place:releases"]);
});

it("leaves the open place alone while Find takes the shortcut for its highlighted result", async () => {
  await go({ kind: "upstream" });
  await press("k", { ctrlKey: true });
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, "Security");
    input?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await press("P");
  expect(readPins()).toEqual(["place:upstream", "place:security"]);
});

const notice = () => document.querySelector<HTMLElement>(".pin-notice:not(:empty)");
const undo = () => notice()?.querySelector<HTMLButtonElement>("button");
async function findUpstream() {
  await press("k", { ctrlKey: true });
  const input = document.querySelector<HTMLInputElement>('[role="dialog"].palette input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "Upstream",
    );
    input?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
}

it.each(["sidebar menu", "top control", "Find control", "Find shortcut", "Line sheet"])(
  "%s offers Undo and keyboard Undo at the old index, persisted each time",
  async (path) => {
    const original = ["place:releases", "place:upstream", "legal", "place:security"];
    await act(async () => {
      localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(original));
      window.dispatchEvent(new StorageEvent("storage", { key: PINS_STORAGE_KEY }));
    });
    const id = path === "Line sheet" ? "legal" : "place:upstream";
    const label = path === "Line sheet" ? "legal" : "Upstream";
    await go({ kind: "upstream" });
    if (path.startsWith("Find")) await findUpstream();
    if (path === "Line sheet") await press("l", { ctrlKey: true });
    const remove = async () => {
      if (path === "sidebar menu") {
        const row = container.querySelector<HTMLElement>('[data-sidebar-row="upstream"]');
        await act(async () =>
          row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
        );
        const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          (item) => item.textContent === "Unpin from sidebar",
        );
        expect(item).toBeDefined();
        await act(async () => item?.click());
      } else if (path === "Find shortcut") await press("P");
      else {
        const selector =
          path === "Find control"
            ? '[role="dialog"].palette [data-pin-state="pinned"] .pin-control'
            : path === "Line sheet"
              ? '[data-service="legal"] .pin-control'
              : ".centre-end > .pin-control";
        const button = document.querySelector<HTMLButtonElement>(selector);
        expect(button).not.toBeNull();
        await act(async () => button?.click());
      }
    };
    for (const method of ["button", "shortcut"]) {
      await remove();
      expect(readPins()).toEqual(original.filter((pin) => pin !== id));
      expect(notice()?.textContent).toBe(`Unpinned ${label}·Undo`);
      if (method === "button") await act(async () => undo()?.click());
      else await press("z", { ctrlKey: true });
      expect(readPins()).toEqual(original);
      expect(JSON.parse(stored() ?? "null")).toEqual(original);
      expect(notice()).toBeNull();
    }
  },
);

it("flashes a pin when Pinned is shown, but offers an undoable pin notice when collapsed or hidden", async () => {
  await go({ kind: "security" });
  await act(async () => control()?.click());
  expect(notice()).toBeNull();
  expect(container.querySelector('[data-pin="place:security"][data-just-pinned]')).not.toBeNull();
  await act(async () => control()?.click());
  await act(async () => undo()?.click());
  const header = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-slot="section-header"]'),
  ].find((button) => button.textContent === "Pinned");
  await act(async () => header?.click());
  await go({ kind: "releases" });
  await act(async () => control()?.click());
  expect(notice()?.textContent).toBe("Pinned Releases·Undo");
  expect(notice()?.dataset.placement).toBe("sidebar");
  await act(async () => undo()?.click());
  expect(readPins()).not.toContain("place:releases");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-sidebar="trigger"]')?.click(),
  );
  const empty = document.querySelector('.pin-notice[data-placement="window"]');
  expect(empty?.textContent).toBe("");
  await act(async () => control()?.click());
  expect(notice()).toBe(empty);
  expect(notice()?.textContent).toBe("Pinned Releases·Undo");
  await act(async () => undo()?.click());
  expect(readPins()).not.toContain("place:releases");
});

it("mounts empty status regions, pauses expiry under hover and focus, and preserves normal Undo after expiry", async () => {
  vi.useFakeTimers();
  const region = document.querySelector('.pin-notice[data-placement="sidebar"]');
  expect(region?.getAttribute("role")).toBe("status");
  expect(region?.textContent).toBe("");
  await go({ kind: "upstream" });
  await act(async () => control()?.click());
  expect(notice()).toBe(region);
  await act(async () => {
    vi.advanceTimersByTime(3_000);
  });
  await act(async () => region?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  await act(async () => undo()?.focus());
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  await act(async () => region?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })));
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(notice()).not.toBeNull();
  await act(async () => undo()?.blur());
  await act(async () => {
    vi.advanceTimersByTime(4_999);
  });
  expect(notice()).not.toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(notice()).toBeNull();
  const event = new KeyboardEvent("keydown", {
    key: "z",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => document.body.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(readPins()).toEqual([]);
});

it.each(["Macintosh", "Windows"])(
  "a fresh notice owns Undo inside Find on %s until another key, leaving text Undo alone afterwards",
  async (platform) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(platform);
    const modifier = platform === "Macintosh" ? { metaKey: true } : { ctrlKey: true };
    // Open Find with the platform's modifier before it creates its notice.
    await press("k", modifier);
    const input = document.querySelector<HTMLInputElement>('[role="dialog"].palette input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "Upstream",
      );
      input?.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    await press("p", { ...modifier, shiftKey: true });
    expect(notice()?.textContent).toBe("Unpinned Upstream·Undo");
    await press(platform === "Macintosh" ? "Meta" : "Control", modifier);
    await press("z", modifier);
    expect(readPins()).toEqual(["place:upstream"]);
    await press("p", { ...modifier, shiftKey: true });
    await press("a", {});
    const event = new KeyboardEvent("keydown", {
      key: "z",
      ...modifier,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input?.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(readPins()).toEqual([]);
    expect(notice()).not.toBeNull();
    await act(async () => undo()?.click());
    expect(readPins()).toEqual(["place:upstream"]);
  },
);

it("keeps the refused-write notice's words and Undo, restores this window, and reloads the accepted list", async () => {
  const original = ["place:releases", "place:upstream", "place:security"];
  await act(async () => {
    localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(original));
    window.dispatchEvent(new StorageEvent("storage", { key: PINS_STORAGE_KEY }));
  });
  await go({ kind: "upstream" });
  const real = localStorage;
  const refused = vi.fn(() => {
    throw new Error("quota");
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => real.getItem(key),
    setItem: refused,
  });
  await act(async () => control()?.click());
  expect(readPins()).toEqual(["place:releases", "place:security"]);
  expect(refused).toHaveBeenCalled();
  expect(stored()).toBe(JSON.stringify(original));
  expect(notice()?.textContent).toBe("Unpinned Upstream·Undo");
  expect(undo()?.textContent).toBe("Undo");
  await act(async () => undo()?.click());
  expect(readPins()).toEqual(original);
  expect(stored()).toBe(JSON.stringify(original));
  vi.unstubAllGlobals();
  vi.resetModules();
  expect((await import("../store/pins.js")).readPins()).toEqual(original);
});
