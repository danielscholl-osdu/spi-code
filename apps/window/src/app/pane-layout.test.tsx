// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { installSpi } from "../test-utils/harness.js";
import { loadPanes, PANES_STORAGE_KEY, savePanes } from "./pane-layout.js";
import { Shell } from "./Shell.js";

type HappyWindow = { happyDOM: { setViewport(viewport: { width: number; height: number }): void } };

const cleanups: Array<() => Promise<void>> = [];

async function resizeWindow(width: number) {
  await act(async () => {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 900 });
    window.dispatchEvent(new Event("resize"));
  });
}

async function mountShell() {
  const harness = installSpi({
    openExternal: async () => true,
    setAppearance: async () => true,
    postMessage: () => undefined,
    onMessage: () => () => undefined,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    container.remove();
    harness.restore();
  };
  cleanups.push(unmount);
  const layout = container.querySelector<HTMLElement>(".shell");
  if (!layout) throw new Error("Missing shell");
  return {
    container,
    layout,
    unmount,
    separator: (label: string) =>
      container.querySelector<HTMLElement>(`[role="separator"][aria-label="${label}"]`),
    column: (name: string) => layout.style.getPropertyValue(name),
  };
}

async function pointer(target: HTMLElement, type: string, clientX: number) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX }),
    );
  });
}

async function drag(target: HTMLElement | null, from: number, to: number) {
  if (!target) throw new Error("Missing separator");
  await pointer(target, "pointerdown", from);
  await pointer(target, "pointermove", to);
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  await pointer(target, "pointerup", to);
}

const saved = () => JSON.parse(localStorage.getItem(PANES_STORAGE_KEY) ?? "null");

beforeEach(async () => {
  localStorage.removeItem(PANES_STORAGE_KEY);
  window.location.hash = "";
  await resizeWindow(1280);
  selectionStore.setState({ selected: null, row: null, result: null, request: null, open: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("saved panes", () => {
  it("falls back pane by pane to the defaults for absent, malformed or out-of-range values", () => {
    expect(loadPanes()).toEqual({
      widths: { sidebar: 232, rightPanel: 360 },
      open: { sidebar: true, rightPanel: false },
    });
    localStorage.setItem(PANES_STORAGE_KEY, "{not json");
    expect(loadPanes().widths.sidebar).toBe(232);
    localStorage.setItem(
      PANES_STORAGE_KEY,
      JSON.stringify({
        widths: { sidebar: 400, rightPanel: 520, lineSheet: "wide" },
        open: { sidebar: false, rightPanel: "yes" },
      }),
    );
    expect(loadPanes()).toEqual({
      widths: { sidebar: 232, rightPanel: 520 },
      open: { sidebar: false, rightPanel: false },
    });
    savePanes({ widths: { sidebar: 250 } });
    expect(saved()).toEqual({
      widths: { sidebar: 250, rightPanel: 520 },
      open: { sidebar: false, rightPanel: false },
    });
  });
});

describe("pane separators", () => {
  it("saves the sidebar's dragged width, showing it live and keeping the centre's 520 px", async () => {
    await resizeWindow(1600);
    const shell = await mountShell();
    const sidebar = shell.separator("Resize sidebar");
    if (!sidebar) throw new Error("Missing sidebar separator");
    expect(sidebar.getAttribute("aria-controls")).toBe("app-sidebar");
    await pointer(sidebar, "pointerdown", 232);
    await pointer(sidebar, "pointermove", 272);
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(shell.column("--sidebar-col")).toBe("272px");
    expect(saved()).toBeNull();
    await pointer(sidebar, "pointerup", 272);
    expect(saved().widths.sidebar).toBe(272);

    await act(async () => {
      sidebar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(saved().widths.sidebar).toBe(232);
    expect(shell.column("--sidebar-col")).toBe("232px");
  });

  it("stops a drag where the centre would fall below 520 px", async () => {
    const shell = await mountShell();
    await shell.unmount();

    selectionStore.setState({ open: false });
    localStorage.removeItem(PANES_STORAGE_KEY);
    await resizeWindow(800);
    const narrow = await mountShell();
    const sidebar = narrow.separator("Resize sidebar");
    expect(sidebar?.getAttribute("aria-valuemax")).toBe("280");
    await drag(sidebar, 232, 500);
    expect(saved().widths.sidebar).toBe(280);
    expect(narrow.layout.dataset.sidebarPresentation).toBe("inline");
  });

  it.each([740, 900, 1440])(
    "keeps a saved open context pane closed outside a thread at %i px",
    async (width) => {
      savePanes({ widths: { rightPanel: 440 }, open: { rightPanel: true } });
      await resizeWindow(width);
      const shell = await mountShell();
      expect(shell.column("--panel-col")).toBe("0px");
      expect(shell.separator("Resize right panel")).toBeNull();
      expect(
        shell.container.querySelector("#app-right-panel, [aria-label='Toggle right panel']"),
      ).toBeNull();
      expect(saved().widths.rightPanel).toBe(440);
      expect(saved().open.rightPanel).toBe(true);
    },
  );

  it("remembers the inline sidebar's state, not an off-canvas peek at 740 px", async () => {
    selectionStore.setState({ open: false });
    const shell = await mountShell();
    const toggle = shell.container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle sidebar"]',
    );
    const sidebar = shell.container.querySelector<HTMLElement>("#app-sidebar");
    await act(async () => toggle?.click());
    expect(sidebar?.dataset.state).toBe("collapsed");
    expect(saved().open.sidebar).toBe(false);
    await resizeWindow(740);
    await act(async () => toggle?.click());
    expect(sidebar?.dataset.mobile).toBe("true");
    expect(sidebar?.dataset.state).toBe("expanded");
    expect(shell.layout.style.getPropertyValue("--sidebar-width")).toBe("232px");
    await act(async () => toggle?.click());
    expect(sidebar?.dataset.state).toBe("collapsed");
    await resizeWindow(1280);
    expect(sidebar?.dataset.mobile).toBeUndefined();
    expect(sidebar?.dataset.state).toBe("collapsed");
    expect(shell.layout.dataset.sidebarPresentation).toBe("closed");
    expect(saved().open.sidebar).toBe(false);
  });
});
