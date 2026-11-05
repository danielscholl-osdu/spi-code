// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

it("renders and handles a React interaction in the window DOM", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let clicks = 0;
  try {
    await act(async () => {
      root.render(
        <button type="button" onClick={() => clicks++}>
          Watch
        </button>,
      );
    });
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Watch");
    await act(async () => button?.click());
    expect(clicks).toBe(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
