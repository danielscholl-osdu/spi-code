// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { routes } from "./routes.js";
import { Shell } from "./Shell.js";

it("renders exactly seven navigable placeholders and the supplied turn panel", async () => {
  const unsubscribe = vi.fn();
  const previous = window.spi;
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: vi.fn(),
    onMessage: () => unsubscribe,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <Shell>
          <p>Turn panel</p>
        </Shell>,
      ),
    );
    expect(routes).toHaveLength(7);
    const buttons = container.querySelectorAll<HTMLButtonElement>("nav button");
    expect(buttons).toHaveLength(7);
    for (const [index, route] of routes.entries()) {
      await act(async () => buttons[index]?.click());
      expect(container.querySelector("main h1")?.textContent).toBe(route.label);
      expect(buttons[index]?.getAttribute("aria-current")).toBe("page");
    }
    expect(container.querySelector("details")?.textContent).toContain("Turn panel");
    expect(container.querySelector("header strong")?.textContent).toBe("SPI Code");
    expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe("Inspector");
  } finally {
    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    container.remove();
    window.spi = previous;
  }
});
