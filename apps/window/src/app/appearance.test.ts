// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it, vi } from "vitest";
import "../test-utils/web-storage.js";
import { createAppearance, type Theme } from "./appearance.js";

function system(dark: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: () => void) => {
      listeners.delete(listener);
    },
  };
  const change = (next: boolean) => {
    media.matches = next;
    for (const listener of listeners) listener();
  };
  return { media, listeners, change };
}

it.each([
  ["dark", false],
  ["light", true],
] as const)("reports a saved %s pin at startup when the system theme disagrees", (pin, dark) => {
  const storage = window.sessionStorage;
  storage.clear();
  storage.setItem("spi-code.appearance", pin);
  const os = system(dark);
  const onTheme = vi.fn<(theme: Theme) => void>();
  const target = document.createElement("div");
  const appearance = createAppearance(storage, os.media, target, onTheme);
  expect(target.dataset.theme).toBe(pin);
  expect(onTheme.mock.calls).toEqual([[pin]]);
  appearance.dispose();
  storage.clear();
});

it("reports each Light, Dark and System change, and system changes only while unpinned", () => {
  const storage = window.sessionStorage;
  storage.clear();
  const os = system(true);
  const onTheme = vi.fn<(theme: Theme) => void>();
  const appearance = createAppearance(storage, os.media, document.createElement("div"), onTheme);
  expect(onTheme.mock.calls).toEqual([["dark"]]);
  appearance.setPin("light");
  expect(onTheme.mock.calls.at(-1)).toEqual(["light"]);
  os.change(false);
  os.change(true);
  expect(onTheme).toHaveBeenCalledTimes(2);
  appearance.setPin("dark");
  expect(onTheme.mock.calls.at(-1)).toEqual(["dark"]);
  os.change(false);
  expect(onTheme).toHaveBeenCalledTimes(3);
  appearance.setPin("system");
  expect(onTheme.mock.calls.at(-1)).toEqual(["light"]);
  os.change(true);
  expect(onTheme.mock.calls.at(-1)).toEqual(["dark"]);
  os.change(false);
  expect(onTheme.mock.calls).toEqual([
    ["dark"],
    ["light"],
    ["dark"],
    ["light"],
    ["dark"],
    ["light"],
  ]);
  appearance.dispose();
  expect(os.listeners.size).toBe(0);
  os.change(true);
  expect(onTheme).toHaveBeenCalledTimes(6);
  storage.clear();
});

it("follows system changes, persists a pin over changes and reload, and unpins to system", () => {
  const listeners = new Set<() => void>();
  const media = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: () => void) => {
      listeners.delete(listener);
    },
  };
  const target = document.createElement("div");
  const storage = window.sessionStorage;
  storage.clear();
  const change = (dark: boolean) => {
    media.matches = dark;
    for (const listener of listeners) listener();
  };
  let appearance = createAppearance(storage, media, target);
  expect(target.dataset.theme).toBe("light");
  change(true);
  expect(target.dataset.theme).toBe("dark");
  appearance.setPin("light");
  change(false);
  change(true);
  expect(target.dataset.theme).toBe("light");
  appearance.dispose();
  expect(listeners.size).toBe(0);
  appearance = createAppearance(storage, media, target);
  expect(appearance.pin).toBe("light");
  expect(target.dataset.theme).toBe("light");
  appearance.setPin("system");
  expect(target.dataset.theme).toBe("dark");
  change(false);
  expect(target.dataset.theme).toBe("light");
  expect(storage.getItem("spi-code.appearance")).toBeNull();
  appearance.setPin("dark");
  change(true);
  change(false);
  expect(target.dataset.theme).toBe("dark");
  appearance.dispose();
  storage.clear();
});
