// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { TITLEBAR_HEIGHT, windowTitleBarOptions } from "./window-chrome.js";

it("insets the macOS traffic lights in the middle of the title bar, with no overlay", () => {
  for (const dark of [true, false])
    expect(windowTitleBarOptions(dark, "darwin")).toEqual({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 13 },
    });
});

it("hides the Windows title bar and draws its caption buttons over the 40 px row", () => {
  expect(windowTitleBarOptions(true, "win32")).toEqual({
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#01000000", height: 40, symbolColor: "#f8fafc" },
  });
  expect(windowTitleBarOptions(false, "win32").titleBarOverlay).toEqual({
    color: "#01000000",
    height: 40,
    symbolColor: "#1f2937",
  });
});

it("matches the overlay height to the row the window draws its title bar in", () => {
  const css = readFileSync(new URL("../../window/src/style.css", import.meta.url), "utf8");
  expect(css).toMatch(new RegExp(`grid-template-rows: ${TITLEBAR_HEIGHT}px `));
});
