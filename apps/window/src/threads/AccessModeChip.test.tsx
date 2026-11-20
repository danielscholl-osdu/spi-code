// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { stubActEnvironment } from "../test-utils/harness.js";
import { AccessModeChip } from "./AccessModeChip.js";

it.each([
  ["supervised", "Supervised"],
  ["auto-accept-edits", "Auto-accept edits"],
] as const)("renders the %s access mode as a named chip", (mode, label) => {
  const restore = stubActEnvironment();
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<AccessModeChip mode={mode} />));
  expect(host.querySelector(`[data-access-mode="${mode}"]`)?.textContent).toBe(label);
  act(() => root.unmount());
  restore();
});
