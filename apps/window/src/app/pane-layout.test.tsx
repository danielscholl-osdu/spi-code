// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectionStore } from "../panels/selection.js";
import { installSpi } from "../test-utils/harness.js";
import { loadPanes, PANES_STORAGE_KEY, savePanes } from "./pane-layout.js";
import { closeSheet, pinSheet } from "./routes.js";
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
  closeSheet();
  window.location.hash = "";
  await resizeWindow(1280);
  selectionStore.setState({ selected: null, row: null, result: null, request: null, open: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  closeSheet();
});

describe("saved panes", () => {
  it("falls back pane by pane to the defaults for absent, malformed or out-of-range values", () => {
    expect(loadPanes()).toEqual({
      widths: { sidebar: 232, rightPanel: 360, lineSheet: 360 },
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
      widths: { sidebar: 232, rightPanel: 520, lineSheet: 360 },
      open: { sidebar: false, rightPanel: false },
    });
    savePanes({ widths: { lineSheet: 330 } });
    expect(saved()).toEqual({
      widths: { sidebar: 232, rightPanel: 520, lineSheet: 330 },
      open: { sidebar: false, rightPanel: false },
    });
  });
});

describe("pane separators", () => {
  it("saves each pane's dragged width, showing it live and keeping the centre's 520 px", async () => {
    await resizeWindow(1600);
    pinSheet();
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

    const right = shell.separator("Resize right panel");
    expect(right?.getAttribute("aria-controls")).toBe("app-right-panel");
    await drag(right, 1240, 1200);
    expect(saved().widths.rightPanel).toBe(400);
    expect(shell.column("--panel-col")).toBe("400px");

    const line = shell.separator("Resize Line sheet");
    expect(line?.getAttribute("aria-controls")).toBe("app-line-sheet");
    expect(shell.container.querySelector("#app-line-sheet")).not.toBeNull();
    expect(line?.getAttribute("aria-valuemax")).toBe("408");
    await drag(line, 900, 700);
    expect(saved().widths.lineSheet).toBe(408);
    expect(shell.column("--sheet-col")).toBe("408px");
    expect(1600 - 272 - 400 - 408).toBe(520);
    expect(shell.layout.dataset.rightPresentation).toBe("inline");
    expect(shell.layout.dataset.linePresentation).toBe("inline");

    await act(async () => {
      line?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });
    expect(saved().widths.lineSheet).toBe(392);
    await act(async () => {
      sidebar.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(saved().widths.sidebar).toBe(232);
    expect(shell.column("--sidebar-col")).toBe("232px");
  });

  it("stops a drag where the centre would fall below 520 px", async () => {
    const shell = await mountShell();
    const right = shell.separator("Resize right panel");
    expect(right?.getAttribute("aria-valuemax")).toBe("528");
    await drag(right, 900, 400);
    expect(saved().widths.rightPanel).toBe(528);
    expect(shell.column("--panel-col")).toBe("528px");
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

  it("shows a narrower width than the saved one without rewriting it, and widening restores it", async () => {
    savePanes({ widths: { rightPanel: 440 } });
    const shell = await mountShell();
    expect(shell.column("--panel-col")).toBe("440px");
    await resizeWindow(1100);
    expect(shell.column("--panel-col")).toBe("348px");
    expect(shell.separator("Resize right panel")?.getAttribute("aria-valuenow")).toBe("348");
    expect(saved().widths.rightPanel).toBe(440);
    await resizeWindow(1280);
    expect(shell.column("--panel-col")).toBe("440px");
    await shell.unmount();

    savePanes({ widths: { rightPanel: 880 }, open: { sidebar: false } });
    await resizeWindow(1600);
    const wide = await mountShell();
    expect(wide.column("--panel-col")).toBe("880px");
    await resizeWindow(1280);
    expect(wide.column("--panel-col")).toBe("704px");
    expect(wide.separator("Resize right panel")?.getAttribute("aria-valuemax")).toBe("704");
    expect(saved().widths.rightPanel).toBe(880);
  });

  it("keeps the preferred width when the stop blocks an outward drag on a narrowed pane", async () => {
    savePanes({ widths: { rightPanel: 440 } });
    const shell = await mountShell();
    await resizeWindow(1100);
    expect(shell.column("--panel-col")).toBe("348px");
    await drag(shell.separator("Resize right panel"), 752, 700);
    expect(shell.column("--panel-col")).toBe("348px");
    expect(saved().widths.rightPanel).toBe(440);
    await resizeWindow(1280);
    expect(shell.column("--panel-col")).toBe("440px");
  });

  it("keeps the preferred width when an unmoved press spans a window resize", async () => {
    savePanes({ widths: { rightPanel: 440 } });
    const shell = await mountShell();
    const right = shell.separator("Resize right panel");
    if (!right) throw new Error("Missing right panel separator");
    await pointer(right, "pointerdown", 840);
    await resizeWindow(1100);
    expect(shell.column("--panel-col")).toBe("348px");
    await pointer(right, "pointerup", 840);
    expect(saved().widths.rightPanel).toBe(440);
    await resizeWindow(1280);
    expect(shell.column("--panel-col")).toBe("440px");
  });

  it("keeps a preferred width above the 55% maximum when an outward drag is held there", async () => {
    savePanes({ widths: { rightPanel: 880 }, open: { sidebar: false } });
    const shell = await mountShell();
    expect(shell.column("--panel-col")).toBe("704px");
    await drag(shell.separator("Resize right panel"), 576, 400);
    expect(saved().widths.rightPanel).toBe(880);
    await resizeWindow(1600);
    expect(shell.column("--panel-col")).toBe("880px");
  });

  it("keeps the pinned Line sheet's preferred width when the stop holds its drag", async () => {
    savePanes({ widths: { lineSheet: 440 } });
    await resizeWindow(1400);
    pinSheet();
    const shell = await mountShell();
    const shown = shell.column("--sheet-col");
    expect(shown).toBe("368px");
    await drag(shell.separator("Resize Line sheet"), 700, 600);
    expect(shell.column("--sheet-col")).toBe(shown);
    expect(saved().widths.lineSheet).toBe(440);
  });

  it("saves a real drag inward while narrowed, as the width the user dragged to", async () => {
    savePanes({ widths: { rightPanel: 440 } });
    const shell = await mountShell();
    await resizeWindow(1100);
    await drag(shell.separator("Resize right panel"), 752, 800);
    expect(saved().widths.rightPanel).toBe(300);
    expect(shell.column("--panel-col")).toBe("300px");
    await resizeWindow(1280);
    expect(shell.column("--panel-col")).toBe("300px");
  });

  it("restores widths and open or collapsed panes on the next launch", async () => {
    await resizeWindow(1600);
    pinSheet();
    selectionStore.setState({ open: false });
    const shell = await mountShell();
    await act(async () =>
      shell.container
        .querySelector<HTMLButtonElement>('[aria-label="Toggle right panel"]')
        ?.click(),
    );
    await drag(shell.separator("Resize right panel"), 1240, 1180);
    await drag(shell.separator("Resize Line sheet"), 900, 880);
    await act(async () =>
      shell.container.querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]')?.click(),
    );
    expect(saved()).toEqual({
      widths: { sidebar: 232, rightPanel: 420, lineSheet: 380 },
      open: { sidebar: false, rightPanel: true },
    });
    await shell.unmount();

    selectionStore.setState({ open: false });
    const relaunched = await mountShell();
    expect(selectionStore.getState().open).toBe(true);
    expect(relaunched.layout.dataset.sidebarPresentation).toBe("closed");
    expect(relaunched.container.querySelector("#app-sidebar")?.getAttribute("data-state")).toBe(
      "collapsed",
    );
    expect(relaunched.column("--panel-col")).toBe("420px");
    expect(relaunched.column("--sheet-col")).toBe("380px");
    expect(relaunched.separator("Resize sidebar")).toBeNull();
    await act(async () =>
      relaunched.container
        .querySelector<HTMLButtonElement>('[aria-label="Toggle right panel"]')
        ?.click(),
    );
    expect(saved().open.rightPanel).toBe(false);
    await relaunched.unmount();

    const closed = await mountShell();
    expect(selectionStore.getState().open).toBe(false);
    expect(closed.layout.dataset.rightPresentation).toBe("closed");
  });

  it("opens a saved open right panel at launch only where it would sit inline", async () => {
    savePanes({ open: { rightPanel: true } });
    selectionStore.setState({ open: false });
    await resizeWindow(900);
    await mountShell();
    expect(selectionStore.getState().open).toBe(false);
    expect(saved().open.rightPanel).toBe(true);
  });

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
