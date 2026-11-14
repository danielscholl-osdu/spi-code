// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

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
