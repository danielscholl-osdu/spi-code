// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { windowControls } from "./window-controls.js";

const chrome = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0";

it("reserves the traffic lights on macOS, the caption overlay on Windows, and nothing in a browser", () => {
  expect(
    windowControls(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${chrome} Electron/44.10.0`),
  ).toBe("inset");
  expect(
    windowControls(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${chrome} Electron/44.10.0`),
  ).toBe("overlay");
  expect(windowControls(`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${chrome}`)).toBe("none");
});

const css = readFileSync("apps/window/src/style.css", "utf8");

it("drags the window by the title bar but not by its controls, beside the native buttons", () => {
  const rule = (selector: string) =>
    css.match(
      new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`),
    )?.[1];
  expect(rule(".title-bar")).toContain("-webkit-app-region: drag");
  expect(rule(".title-bar :is(button, select, input, textarea, a, label, summary)")).toContain(
    "-webkit-app-region: no-drag",
  );
  expect(rule('.shell[data-window-controls="inset"] .title-bar')).toMatch(/padding-left: \d+px/);
  expect(rule('.shell[data-window-controls="overlay"] .title-bar')).toContain(
    "env(titlebar-area-width",
  );
});
