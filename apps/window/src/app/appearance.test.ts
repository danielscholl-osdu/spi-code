// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { expect, it } from "vitest";
import { createAppearance } from "./appearance.js";

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
