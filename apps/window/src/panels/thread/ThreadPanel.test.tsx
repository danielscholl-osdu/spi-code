// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { ViewSnapshot } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFixture } from "../../../../../scripts/watch-generated.mjs";
import { PANES_STORAGE_KEY, savePanes } from "../../app/pane-layout.js";
import { Shell } from "../../app/Shell.js";
import { watchStore } from "../../store/watch.js";
import { fixtureLoader, installSpi } from "../../test-utils/harness.js";
import { type ThreadSummary, threadStore } from "../../threads/store.js";

type HappyWindow = { happyDOM: { setViewport(viewport: { width: number; height: number }): void } };

const fixture = fixtureLoader(readFixture)("snapshot-1106.json");
const cleanups: Array<() => Promise<void>> = [];
const watched = watchStore.getState();
const threads = threadStore.getState();

function summary(thread: ThreadSummary["thread"]): ThreadSummary {
  return {
    id: "t1",
    thread,
    status: "Open",
    sequence: 1,
    updatedAt: 1,
    settledAt: null,
    done: false,
  };
}

async function resizeWindow(width: number) {
  await act(async () => {
    (window as unknown as HappyWindow).happyDOM.setViewport({ width, height: 900 });
    window.dispatchEvent(new Event("resize"));
  });
}

async function mountShell(
  hash: string,
  listed: readonly ThreadSummary[] | null,
  snapshot: ViewSnapshot | null = fixture,
) {
  window.location.hash = hash;
  watchStore.setState({
    snapshot: snapshot && { cursor: snapshot.cursor, body: snapshot },
    setup: null,
  });
  threadStore.setState({ threads: listed });
  const harness = installSpi();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
    harness.restore();
  });
  const layout = container.querySelector<HTMLElement>(".shell");
  if (!layout) throw new Error("Missing shell");
  const $ = <T extends Element = HTMLElement>(selector: string) =>
    container.querySelector<T & HTMLElement>(selector);
  return {
    $,
    layout,
    panel: () => $("#app-right-panel"),
    column: () => layout.style.getPropertyValue("--panel-col"),
    toggles: () => [
      ...container.querySelectorAll<HTMLButtonElement>("button[aria-label='Toggle right panel']"),
    ],
    title: () => $(".centre-title h1")?.textContent,
    tab: async (label: string) => {
      const tab = [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(
        (candidate) => candidate.textContent === label,
      );
      if (!tab) throw new Error(`Missing tab ${label}`);
      await act(async () => tab.click());
      return $("#app-right-panel [role=tabpanel]");
    },
  };
}

const press = (key: string, target: EventTarget = window) =>
  act(async () => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ctrlKey: true }),
    );
  });

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
const PARTITION = summary({ scope: "partition", title: "Fix the blob retry test" });

beforeEach(async () => {
  localStorage.removeItem(PANES_STORAGE_KEY);
  await resizeWindow(1440);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  watchStore.setState(watched, true);
  threadStore.setState(threads, true);
  window.location.hash = "";
});

describe("a thread's right panel", () => {
  it.each(["#today", "#service/partition", "#thread/new"])(
    "is absent with no toggle and no shortcut on %s",
    async (hash) => {
      savePanes({ open: { rightPanel: true } });
      const shell = await mountShell(hash, [PARTITION]);
      await press("i");
      expect(shell.panel()).toBeNull();
      expect(shell.toggles()).toEqual([]);
      expect(shell.column()).toBe("0px");
      expect(saved().open.rightPanel).toBe(true);
    },
  );

  it("opens inline from its toggle, moves the toggle to its tabs and closes back", async () => {
    const shell = await mountShell("#thread/t1", [PARTITION]);
    expect(shell.panel()).toBeNull();
    const [open] = shell.toggles();
    expect(open?.closest(".centre-end")).not.toBeNull();
    open?.focus();
    await act(async () => open?.click());
    expect(shell.panel()?.hasAttribute("data-sheet")).toBe(false);
    expect(shell.layout.dataset.rightPresentation).toBe("inline");
    expect(shell.column()).toBe("360px");
    const [close] = shell.toggles();
    expect(shell.toggles()).toHaveLength(1);
    expect(close?.closest(".panel-tabs")).not.toBeNull();
    expect(saved().open.rightPanel).toBe(true);

    shell.$<HTMLButtonElement>("#app-right-panel [role=tab]")?.focus();
    await press("Escape", document.activeElement ?? window);
    expect(shell.panel()).toBeNull();
    expect(document.activeElement).toBe(shell.toggles()[0]);
    expect(saved().open.rightPanel).toBe(false);
    await press("i");
    expect(shell.panel()).not.toBeNull();
    await press("i");
    expect(shell.panel()).toBeNull();
  });

  it("resizes within the width budget, the centre keeping 520 px", async () => {
    const shell = await mountShell("#thread/t1", [PARTITION]);
    await act(async () => shell.toggles()[0]?.click());
    const edge = shell.$('[role="separator"][aria-label="Resize right panel"]');
    expect(edge?.getAttribute("aria-controls")).toBe("app-right-panel");
    expect(edge?.getAttribute("aria-valuemax")).toBe("688");
    await drag(edge, 1080, 1000);
    expect(saved().widths.rightPanel).toBe(440);
    expect(shell.column()).toBe("440px");
    await drag(shell.$('[role="separator"][aria-label="Resize right panel"]'), 1000, 400);
    expect(saved().widths.rightPanel).toBe(688);
    expect(1440 - 232 - 688).toBe(520);
    await resizeWindow(1100);
    expect(shell.column()).toBe("348px");
    expect(saved().widths.rightPanel).toBe(688);
  });

  it("becomes a sheet over the window under the narrow width", async () => {
    await resizeWindow(900);
    const shell = await mountShell("#thread/t1", [PARTITION]);
    await act(async () => shell.toggles()[0]?.click());
    expect(shell.layout.dataset.rightPresentation).toBe("sheet");
    expect(shell.panel()?.hasAttribute("data-sheet")).toBe(true);
    expect(shell.column()).toBe("0px");
    expect(shell.layout.style.getPropertyValue("--right-panel-width")).toBe("360px");
    expect(shell.$('[role="separator"][aria-label="Resize right panel"]')).toBeNull();
    expect(document.activeElement?.closest("#app-right-panel")).not.toBeNull();
    await act(async () => shell.$(".context-backdrop")?.click());
    expect(shell.panel()).toBeNull();
    await resizeWindow(1440);
    await act(async () => shell.toggles()[0]?.click());
    expect(shell.layout.dataset.rightPresentation).toBe("inline");
    await resizeWindow(900);
    expect(shell.panel()?.hasAttribute("data-sheet")).toBe(true);
  });

  it.each([
    [1440, true],
    [900, false],
  ])(
    "reopens a saved open panel at launch at %i px only where it sits inline",
    async (width, open) => {
      savePanes({ open: { rightPanel: true } });
      await resizeWindow(width);
      const shell = await mountShell("#thread/t1", [PARTITION]);
      expect(shell.panel() !== null).toBe(open);
      expect(saved().open.rightPanel).toBe(true);
    },
  );
});

describe("Reading", () => {
  it("draws the scope's place without taking the thread's title", async () => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", [PARTITION]);
    const body = await shell.tab("Reading");
    expect(body?.querySelector("[data-view-pane=service]")?.getAttribute("aria-label")).toBe(
      "partition",
    );
    expect(body?.querySelector("[aria-label='How code reaches partition main']")).not.toBeNull();
    expect(body?.textContent).not.toContain("not read");
    expect(shell.title()).toBe("Fix the blob retry test");
  });

  it("says the fork was not read when the sweep holds no home for it", async () => {
    savePanes({ open: { rightPanel: true } });
    const unread = {
      ...fixture,
      services: fixture.services?.filter(({ service }) => service !== "partition"),
    };
    const shell = await mountShell("#thread/t1", [PARTITION], unread);
    const body = await shell.tab("Reading");
    expect(body?.querySelector("[data-quiet=unread]")?.textContent).toBe(
      "⌀ This fork was not read.",
    );
    expect(body?.querySelector("[aria-label='How code reaches partition main']")).toBeNull();
  });

  it.each([
    ["not listed yet", null],
    ["unknown to the host", []],
  ])("says the scope is not known while the thread is %s", async (_, listed) => {
    savePanes({ open: { rightPanel: true } });
    const shell = await mountShell("#thread/t1", listed);
    for (const tab of ["Reading", "Evidence"]) {
      const body = await shell.tab(tab);
      expect(body?.textContent).toBe("⌀ This thread's scope is not known.");
    }
  });
});

describe("Evidence", () => {
  it("shows what the thread started from, then its scope's reads", async () => {
    savePanes({ open: { rightPanel: true } });
    const thread = summary({ scope: "entitlements", subject: "conflict:entitlements:121" });
    const shell = await mountShell("#thread/t1", [thread]);
    const body = await shell.tab("Evidence");
    const chip = body?.querySelector("[data-evidence-for=chip]");
    expect(chip?.querySelector(".evidence-lede")?.textContent).toMatch(
      /^entitlements · Sync has a merge conflict · sweep ended /,
    );
    expect(chip?.querySelector("[data-evidence-part=areas]")).not.toBeNull();
    const scope = body?.querySelector("[data-evidence-for=scope]");
    expect(scope?.querySelector(".evidence-lede")?.textContent).toMatch(
      /^entitlements · sweep ended /,
    );
    expect(scope?.querySelector("[aria-label=Areas]")?.querySelectorAll("tr").length).toBe(10);
  });

  it.each([
    ["sync-run:gone", "gone"],
    ["service:partition", "partition"],
  ])("claims nothing for chip %s that Today does not hold", async (subject, scope) => {
    savePanes({ open: { rightPanel: true } });
    const unread = { ...fixture, services: [] };
    const shell = await mountShell("#thread/t1", [summary({ scope, subject })], unread);
    const body = await shell.tab("Evidence");
    expect(body?.querySelector("[data-evidence-for=chip] .evidence-lede")?.textContent).toMatch(
      /^Today holds nothing for the row this thread started from · sweep ended /,
    );
    expect(body?.querySelector("[data-evidence-for=chip] [data-evidence-part]")).toBeNull();
    expect(body?.querySelector("[data-evidence-for=scope] [data-quiet=unread]")?.textContent).toBe(
      "⌀ This fork was not read.",
    );
  });
});
