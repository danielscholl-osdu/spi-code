// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { testSnapshot } from "../store/test-snapshot.js";
import { watchStore } from "../store/watch.js";
import { Shell } from "./Shell.js";

type HappyWindow = { happyDOM: { setViewport(viewport: { width: number; height: number }): void } };
const viewport = (width: number, height = 900) =>
  (window as unknown as HappyWindow).happyDOM.setViewport({ width, height });

async function mountShell() {
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
  await act(async () => root.render(<Shell />));
  return {
    container,
    unsubscribe,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      window.spi = previous;
    },
  };
}

const press = (key: string, init: KeyboardEventInit = { ctrlKey: true }) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });

beforeEach(() => {
  window.location.hash = "";
  viewport(1280);
});

it("navigates every sidebar thing through the hash, naming the place in the title bar", async () => {
  const shell = await mountShell();
  const { container } = shell;
  try {
    const place = () => container.querySelector("header [data-place]")?.textContent;
    const button = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
        (item) => item.textContent === label,
      );
    expect(place()).toBe("Inbox");
    expect(container.querySelector("main h1")?.textContent).toBe("Inbox");
    expect(container.querySelector("main")?.textContent).toContain("First sweep running");
    for (const [label, hash] of [
      ["Template", "#template"],
      ["Environment", "#environment"],
      ["Releases", "#releases"],
      ["Flow", "#lens/flow"],
      ["Repositories", "#lens/repositories"],
      ["Horizon", "#lens/horizon"],
      ["Setup", "#setup"],
      ["Inbox", "#inbox"],
    ] as const) {
      await act(async () => button(label)?.click());
      expect(window.location.hash).toBe(hash);
      expect(container.querySelector("main h1")?.textContent).toBe(label);
      expect(place()).toBe(label);
      expect(button(label)?.getAttribute("aria-current")).toBe("page");
    }
    for (const [hash, label] of [
      ["#service/legal", "legal"],
      ["#release/2026-10", "Release 2026-10"],
    ] as const) {
      await act(async () => {
        window.location.hash = hash;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(container.querySelector("main h1")?.textContent).toBe(label);
      expect(place()).toBe(label);
    }
    expect(button("Releases")?.getAttribute("aria-current")).toBe("true");
    expect(container.querySelector("header strong")?.textContent).toBe("SPI Code");
    expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe("Inspector");
  } finally {
    await shell.cleanup();
    expect(shell.unsubscribe).toHaveBeenCalledTimes(1);
  }
});

it("toggles the sidebar and right panel from named buttons and Ctrl shortcuts, and explains the terminal", async () => {
  const shell = await mountShell();
  const { container } = shell;
  try {
    const toggle = (label: string) =>
      container.querySelector<HTMLButtonElement>(`header button[aria-label="${label}"]`);
    const sidebar = () => container.querySelector<HTMLElement>('nav[aria-label="Sidebar"]');
    for (const label of ["Toggle sidebar", "Toggle terminal", "Toggle right panel"]) {
      expect(toggle(label)?.disabled).toBe(false);
      expect(toggle(label)?.tabIndex).toBe(0);
    }
    expect(toggle("Toggle sidebar")?.getAttribute("aria-keyshortcuts")).toBe("Control+B");
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    await act(async () => toggle("Toggle sidebar")?.click());
    expect(sidebar()?.getAttribute("data-state")).toBe("collapsed");
    expect(sidebar()?.hasAttribute("inert")).toBe(true);
    expect(toggle("Toggle sidebar")?.getAttribute("aria-pressed")).toBe("false");
    await press("b");
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    await press("b", { metaKey: true });
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");

    expect(container.querySelector("aside")).not.toBeNull();
    await act(async () => toggle("Toggle right panel")?.click());
    expect(container.querySelector("aside")).toBeNull();
    expect(toggle("Toggle right panel")?.getAttribute("aria-pressed")).toBe("false");
    await press("i");
    expect(container.querySelector("aside")).not.toBeNull();

    const terminal = toggle("Toggle terminal");
    expect(terminal?.getAttribute("aria-disabled")).toBe("true");
    const reason = terminal?.getAttribute("aria-describedby") ?? "";
    expect(container.querySelector(`[id="${reason}"]`)?.textContent).toBe(
      "The terminal is not available yet",
    );
    await act(async () => terminal?.click());
    await press("j");
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    expect(container.querySelector("aside")).not.toBeNull();
  } finally {
    await shell.cleanup();
  }
});

it("opens the sidebar off-canvas below 980 px and closes it on Escape, back to its toggle", async () => {
  viewport(800);
  const shell = await mountShell();
  const { container } = shell;
  try {
    const sidebar = () => container.querySelector<HTMLElement>('nav[aria-label="Sidebar"]');
    const trigger = container.querySelector<HTMLButtonElement>(
      'header button[aria-label="Toggle sidebar"]',
    );
    expect(sidebar()?.getAttribute("data-state")).toBe("collapsed");
    expect(sidebar()?.hasAttribute("inert")).toBe(true);
    expect(trigger?.getAttribute("aria-pressed")).toBe("false");
    trigger?.focus();
    await act(async () => trigger?.click());
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    expect(sidebar()?.getAttribute("data-mobile")).toBe("true");
    expect(sidebar()?.hasAttribute("inert")).toBe(false);
    expect(sidebar()?.contains(document.activeElement)).toBe(true);
    expect(container.querySelector('[data-slot="sidebar-backdrop"]')).not.toBeNull();
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(sidebar()?.getAttribute("data-state")).toBe("collapsed");
    expect(document.activeElement).toBe(trigger);
    expect(container.querySelector('[data-slot="sidebar-backdrop"]')).toBeNull();
  } finally {
    await shell.cleanup();
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

it.each(["failed", "stale"] as const)(
  "updates the title bar from a %s non-area release envelope and clears it on recovery",
  async (state) => {
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
    const base = testSnapshot(briefing, releases);
    const areas = base.areas.map(({ area }) => ({
      area,
      envelope: {
        source: area,
        state: "fresh" as const,
        observedAt: base.sweptAt,
        completeness: { kind: "complete" as const },
      },
    }));
    const releaseEnvelope = {
      source: "releases",
      state,
      observedAt: base.sweptAt,
      completeness: { kind: "complete" as const },
      inferred: true,
    };
    const degraded = testSnapshot(briefing, releases, {
      areas,
      provenance: [
        { path: "/releases", areas: ["fleet"], envelope: releaseEnvelope },
        { path: "/releases/lines/0", areas: ["fleet"], envelope: releaseEnvelope },
      ],
    });
    const recovered = testSnapshot(briefing, releases, { cursor: 2, areas });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<Shell />));
      for (const [snapshot, expected] of [
        [degraded, state],
        [recovered, "fresh"],
        [degraded, "fresh"],
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
        const badge = container.querySelector("header [data-envelope]");
        expect(badge?.getAttribute("data-envelope")).toBe(expected);
        expect(badge?.querySelector("[data-inferred]") !== null).toBe(expected !== "fresh");
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      watchStore.setState(previousState);
      window.spi = previous;
    }
  },
);

it("shows each snapshot's services in the sidebar on every route, as the packaged smoke reads it", async () => {
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
  const deliver = (cursor: number, service: string) =>
    act(async () =>
      receive?.({
        version: PROTOCOL_VERSION,
        id: `snapshot-${cursor}`,
        kind: "event",
        type: "view.snapshot",
        payload: testSnapshot(briefing, releases, {
          cursor,
          tree: [{ id: `service:${service}`, status: "unread" }],
        }),
      }),
    );
  try {
    await act(async () => root.render(<Shell />));
    const sidebar = () => container.querySelector<HTMLElement>("#app-sidebar");
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    expect(sidebar()?.textContent).not.toContain("smoke-persisted");
    await deliver(1, "smoke-persisted");
    for (const hash of ["#inbox", "#setup", "#environment", "#service/smoke-persisted"]) {
      await act(async () => {
        window.location.hash = hash;
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      });
      expect(sidebar()?.textContent).toContain("smoke-persisted");
    }
    await deliver(2, "smoke-resumed");
    expect(sidebar()?.textContent).toContain("smoke-resumed");
    expect(sidebar()?.textContent).not.toContain("smoke-persisted");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState(previousState);
    window.spi = previous;
  }
});
