// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { stubActEnvironment } from "../test-utils/harness.js";
import { type Appearance, createAppearance } from "./appearance.js";

const pins: Appearance[] = [];

function Pinned() {
  useEffect(() => {
    const appearance = createAppearance();
    appearance.setPin("dark");
    const reread = createAppearance();
    pins.push(reread.pin);
    reread.dispose();
    appearance.setPin("system");
    return () => appearance.dispose();
  }, []);
  return null;
}

it("gives a component's default appearance storage the window's storage with no test import", async () => {
  const root = createRoot(document.createElement("div"));
  const restoreAct = stubActEnvironment();
  try {
    await act(async () => root.render(<Pinned />));
    act(() => root.unmount());
  } finally {
    restoreAct();
  }
  expect(pins).toEqual(["dark"]);
});
