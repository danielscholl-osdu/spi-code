// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { testSnapshot } from "../store/test-snapshot.js";
import { watchStore } from "../store/watch.js";
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

it("updates the title bar from the worst live area envelope, or unread before a snapshot", async () => {
  const previous = window.spi;
  const previousState = watchStore.getState();
  let receive: Parameters<typeof window.spi.onMessage>[0] | undefined;
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: vi.fn(),
    onMessage: (listener) => {
      receive = listener;
      return vi.fn();
    },
  };
  watchStore.setState({ snapshot: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const base = testSnapshot(briefing, releases);
  const freshAreas = base.areas.map(({ area }) => ({
    area,
    envelope: {
      source: area,
      state: "fresh" as const,
      observedAt: base.sweptAt,
      completeness: { kind: "complete" as const },
    },
  }));
  const failed = testSnapshot(briefing, releases, {
    areas: freshAreas.map((entry) =>
      entry.area === "github"
        ? { ...entry, envelope: { ...entry.envelope, state: "failed", inferred: true } }
        : entry,
    ),
  });
  const recovered = testSnapshot(briefing, releases, { cursor: 2, areas: freshAreas });
  try {
    await act(async () => root.render(<Shell />));
    const badge = () => container.querySelector("header [data-envelope]");
    expect(badge()?.getAttribute("data-envelope")).toBe("unread");
    for (const [snapshot, expected] of [
      [failed, "failed"],
      [recovered, "fresh"],
      [failed, "fresh"],
    ] as const) {
      await act(async () =>
        receive?.({
          version: PROTOCOL_VERSION,
          id: `snapshot-${snapshot.cursor}`,
          kind: "event",
          type: "view.snapshot",
          payload: snapshot,
        }),
      );
      expect(badge()?.getAttribute("data-envelope")).toBe(expected);
      expect(badge()?.querySelector("[data-inferred]") !== null).toBe(expected === "failed");
      if (expected === "failed") expect(badge()?.textContent).toContain("read failed · github");
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState(previousState);
    window.spi = previous;
  }
});
