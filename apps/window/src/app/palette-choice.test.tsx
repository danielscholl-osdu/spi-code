// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { stubActEnvironment } from "../test-utils/harness.js";
import { createAppearance } from "./appearance.js";
import { applyPalette, readPalette, setPalette, usePalette } from "./palette-choice.js";

function Choice() {
  return <output>{usePalette()}</output>;
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem("spi-code.palette");
  applyPalette();
});

it.each([
  ["warm", "warm"],
  ["neutral", "neutral"],
  [null, "neutral"],
  ["unknown", "neutral"],
  ["", "neutral"],
] as const)("starts with %s stored as %s", (stored, expected) => {
  if (stored === null) localStorage.removeItem("spi-code.palette");
  else localStorage.setItem("spi-code.palette", stored);
  const appearance = createAppearance();
  expect(document.documentElement.dataset.palette).toBe(expected);
  appearance.dispose();
});

it.each(["warm", "neutral"] as const)("applies %s at once and restores it at startup", (choice) => {
  setPalette(choice === "warm" ? "neutral" : "warm");
  setPalette(choice);
  expect(document.documentElement.dataset.palette).toBe(choice);
  expect(readPalette()).toBe(choice);
  applyPalette(choice === "warm" ? "neutral" : "warm");
  const appearance = createAppearance();
  expect(document.documentElement.dataset.palette).toBe(choice);
  appearance.dispose();
});

it("defaults to Neutral when storage cannot be read", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation((key) => {
    if (key === "spi-code.palette") throw new Error("unavailable");
    return null;
  });
  applyPalette("warm");
  const appearance = createAppearance();
  expect(document.documentElement.dataset.palette).toBe("neutral");
  appearance.dispose();
});

it("keeps the applied choice observable when storage cannot be written", async () => {
  const restoreAct = stubActEnvironment();
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    applyPalette("neutral");
    await act(async () => root.render(<Choice />));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("unavailable");
    });
    await act(async () => setPalette("warm"));
    expect(document.documentElement.dataset.palette).toBe("warm");
    expect(container.textContent).toBe("warm");
  } finally {
    act(() => root.unmount());
    restoreAct();
  }
});

it.each(["light", "dark"] as const)("keeps palette independent of the %s theme", (theme) => {
  const appearance = createAppearance();
  appearance.setPin(theme);
  for (const palette of ["warm", "neutral"] as const) {
    setPalette(palette);
    expect(document.documentElement.dataset.theme).toBe(theme);
    expect(document.documentElement.dataset.palette).toBe(palette);
    appearance.setPin(theme === "light" ? "dark" : "light");
    expect(document.documentElement.dataset.palette).toBe(palette);
    appearance.setPin(theme);
  }
  appearance.setPin("system");
  appearance.dispose();
});
