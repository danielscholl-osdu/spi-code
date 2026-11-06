// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { NARROW_LAYOUT_MEDIA_QUERY } from "../components/sidebar/ui-sidebar.js";
import { RightPanelFrame } from "./RightPanelFrame.js";
import { createSelectionStore } from "./selection.js";

afterEach(() => vi.restoreAllMocks());

async function mount(width: number) {
  const media = window.matchMedia(NARROW_LAYOUT_MEDIA_QUERY);
  vi.spyOn(media, "matches", "get").mockImplementation(() => width < 980);
  vi.spyOn(window, "matchMedia").mockReturnValue(media);
  const store = createSelectionStore({ postMessage: vi.fn() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <>
        <button
          type="button"
          aria-controls="app-right-panel"
          onClick={() => store.getState().setOpen(!store.getState().open)}
        >
          Detail
        </button>
        <button type="button" onClick={() => store.getState().select("repo:legal")}>
          Legal
        </button>
        <RightPanelFrame store={store} />
      </>,
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>("[aria-controls]");
  const row = container.querySelectorAll<HTMLButtonElement>("button")[1];
  if (!trigger || !row) throw new Error("Missing test controls");
  return {
    store,
    container,
    trigger,
    row,
    panel: () => container.querySelector("#app-right-panel"),
    resize: async (next: number) =>
      act(async () => {
        width = next;
        media.dispatchEvent(new Event("change"));
      }),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it.each([980, 1280])(
  "starts closed, and navigation clears the selection and closes the panel at %i px",
  async (width) => {
    const view = await mount(width);
    try {
      expect(view.panel()).toBeNull();
      view.store.getState().visit("repositories", ["repo:legal"], 0);
      view.row.focus();
      await act(async () => view.row.click());
      expect(view.panel()).not.toBeNull();
      await act(async () => view.store.getState().visit("setup", [], 0));
      expect(view.store.getState().selected).toBeNull();
      expect(view.store.getState().request).toBeNull();
      // PS-11: nothing selected leaves nothing to show, at every width.
      expect(view.panel()).toBeNull();
      expect(document.activeElement).toBe(view.row);
      await act(async () => view.row.click());
      await act(async () => view.store.getState().clear());
      expect(view.panel()).toBeNull();
      expect(view.container.textContent).not.toContain("No selection");
    } finally {
      await view.cleanup();
    }
  },
);

it.each([979, 980])(
  "keeps focus inside or outside the panel when crossing 980 px from %i px",
  async (width) => {
    const view = await mount(width);
    try {
      view.row.focus();
      await act(async () => view.row.click());
      const evidence = view.panel()?.querySelector<HTMLButtonElement>('[role="tab"]:nth-child(2)');
      if (!evidence) throw new Error("Missing Evidence tab");
      evidence.focus();
      await act(async () => evidence.click());
      for (const next of [width < 980 ? 980 : 979, width]) {
        await view.resize(next);
        expect(document.activeElement).toBe(evidence);
        expect(view.panel()?.hasAttribute("data-sheet")).toBe(next < 980);
        expect(evidence.getAttribute("aria-selected")).toBe("true");
      }
      view.row.focus();
      await view.resize(width < 980 ? 980 : 979);
      expect(document.activeElement).toBe(view.row);
      evidence.focus();
      await act(async () => view.store.getState().setOpen(false));
      expect(document.activeElement).toBe(view.row);
    } finally {
      await view.cleanup();
    }
  },
);

it("keeps an empty inline panel and its focus when it becomes a sheet", async () => {
  const view = await mount(980);
  try {
    await act(async () => view.trigger.click());
    const detail = view.panel()?.querySelector<HTMLButtonElement>('[role="tab"]');
    if (!detail) throw new Error("Missing Detail tab");
    detail.focus();
    await view.resize(979);
    expect(view.panel()?.hasAttribute("data-sheet")).toBe(true);
    expect(document.activeElement).toBe(detail);
  } finally {
    await view.cleanup();
  }
});

it.each([980, 1280])(
  "closes an empty panel on narrowing from %i px without moving outside focus",
  async (width) => {
    const view = await mount(width);
    try {
      view.row.focus();
      await view.resize(979);
      expect(view.panel()).toBeNull();
      expect(view.container.querySelector(".detail-backdrop")).toBeNull();
      expect(document.activeElement).toBe(view.row);
      view.trigger.focus();
      await act(async () => view.trigger.click());
      expect(view.panel()?.hasAttribute("data-sheet")).toBe(true);
      expect(view.panel()?.contains(document.activeElement)).toBe(true);
      await act(async () => view.store.getState().setOpen(false));
      expect(document.activeElement).toBe(view.trigger);
    } finally {
      await view.cleanup();
    }
  },
);

it.each([979, 980])("Escape closes only with focus inside the panel at %i px", async (width) => {
  const view = await mount(width);
  const pressEscape = (target: EventTarget, prevented = false) => {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    if (prevented) event.preventDefault();
    target.dispatchEvent(event);
    return event;
  };
  try {
    view.row.focus();
    await act(async () => view.row.click());
    view.trigger.focus();
    await act(async () => {
      expect(pressEscape(view.trigger).defaultPrevented).toBe(false);
    });
    expect(view.panel()).not.toBeNull();
    const detail = view.panel()?.querySelector<HTMLButtonElement>('[role="tab"]');
    if (!detail) throw new Error("Missing Detail tab");
    detail.focus();
    await act(async () => pressEscape(detail, true));
    expect(view.panel()).not.toBeNull();
    await act(async () => {
      expect(pressEscape(detail).defaultPrevented).toBe(true);
    });
    expect(view.panel()).toBeNull();
    expect(document.activeElement).toBe(view.row);
  } finally {
    await view.cleanup();
  }
});

it.each([980, 1280])(
  "keeps the sweep's Evidence reachable with nothing selected at %i px",
  async (width) => {
    const view = await mount(width);
    try {
      await act(async () => view.store.getState().openSweepEvidence());
      expect(view.panel()).not.toBeNull();
      await act(async () => view.store.getState().clear());
      expect(view.panel()).not.toBeNull();
      expect(view.store.getState()).toMatchObject({ tab: "evidence", evidenceScope: "sweep" });
      await act(async () => view.store.getState().setOpen(false));
      expect(view.panel()).toBeNull();
      await act(async () => view.trigger.click());
      expect(view.panel()).not.toBeNull();
      expect(view.store.getState()).toMatchObject({ tab: "evidence", evidenceScope: "sweep" });
      await act(async () => view.row.click());
      await act(async () => view.store.getState().setTab("detail"));
      await act(async () => view.store.getState().clear());
      expect(view.panel()).toBeNull();
    } finally {
      await view.cleanup();
    }
  },
);

it.each([979, 1280])(
  "closes rather than showing an empty Detail after the sweep's Evidence at %i px",
  async (width) => {
    const view = await mount(width);
    try {
      view.trigger.focus();
      await act(async () => view.trigger.click());
      expect(view.store.getState()).toMatchObject({ tab: "evidence", evidenceScope: "sweep" });
      const detail = [
        ...(view.panel()?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []),
      ].find((tab) => tab.textContent === "Detail");
      if (!detail) throw new Error("Missing Detail tab");
      detail.focus();
      await act(async () => detail.click());
      expect(view.panel()).toBeNull();
      expect(view.container.textContent).not.toContain("No selection");
      expect(document.activeElement).toBe(view.trigger);
      await act(async () => view.trigger.click());
      expect(view.store.getState()).toMatchObject({ tab: "evidence", evidenceScope: "sweep" });
      expect(view.panel()).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  },
);
