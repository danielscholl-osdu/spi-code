// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { InspectResultSchema, PROTOCOL_VERSION, type ReadRecord } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { selectionStore } from "../panels/selection.js";
import { PINS_STORAGE_KEY } from "../store/pins.js";
import { testSnapshot } from "../store/test-snapshot.js";
import { watchStore } from "../store/watch.js";
import { PANES_STORAGE_KEY } from "./pane-layout.js";
import { closeSheet, navigate, pinSheet } from "./routes.js";
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
    setAppearance: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => unsubscribe,
  };
  const spi = window.spi;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  return {
    container,
    unsubscribe,
    spi,
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
  localStorage.removeItem(PANES_STORAGE_KEY);
  closeSheet();
  window.location.hash = "";
  viewport(1280);
  selectionStore.setState({
    selected: null,
    row: null,
    result: null,
    request: null,
    open: true,
    tab: "detail",
    evidenceScope: "selection",
  });
});

it("re-decides the pane presentations and widths through all eight drawn cases", async () => {
  const shell = await mountShell();
  const layout = shell.container.querySelector<HTMLElement>(".shell");
  if (!layout) throw new Error("Missing shell");
  try {
    for (const [width, pinned, centre, sidebar, line, lineWidth, detail, detailWidth] of [
      [1600, false, 1008, "inline", "closed", 0, "inline", 360],
      [1440, true, 520, "inline", "inline", 360, "inline", 328],
      [1280, true, 688, "inline", "inline", 360, "sheet", 360],
      [1100, false, 520, "inline", "closed", 0, "inline", 348],
      [1100, true, 520, "inline", "inline", 348, "sheet", 360],
      [980, false, 748, "inline", "closed", 0, "sheet", 360],
      [900, true, 668, "inline", "stacked", 668, "sheet", 360],
      [740, false, 740, "off-canvas", "closed", 0, "sheet", 360],
    ] as const) {
      await act(async () => {
        viewport(width);
        window.dispatchEvent(new Event("resize"));
        if (pinned) pinSheet();
        else closeSheet();
      });
      expect(layout.dataset.sidebarPresentation).toBe(sidebar);
      expect(layout.dataset.linePresentation).toBe(line);
      expect(layout.dataset.rightPresentation).toBe(detail);
      expect(
        width -
          Number.parseFloat(layout.style.getPropertyValue("--sidebar-col")) -
          Number.parseFloat(layout.style.getPropertyValue("--sheet-col")) -
          Number.parseFloat(layout.style.getPropertyValue("--panel-col")),
      ).toBe(centre);
      expect(layout.style.getPropertyValue("--panel-col")).toBe(
        `${detail === "inline" ? detailWidth : 0}px`,
      );
      expect(layout.style.getPropertyValue("--sheet-col")).toBe(
        `${line === "inline" ? lineWidth : 0}px`,
      );
      expect(layout.style.getPropertyValue("--right-panel-width")).toBe(`${detailWidth}px`);
      expect(layout.style.getPropertyValue("--sidebar-col")).toBe(
        `${sidebar === "inline" ? 232 : 0}px`,
      );
      expect(shell.container.querySelector(".line-sheet")?.getAttribute("data-presentation")).toBe(
        pinned ? (line === "stacked" ? "stacked" : "pinned") : undefined,
      );
      expect(shell.container.querySelector("#app-right-panel")?.hasAttribute("data-sheet")).toBe(
        detail === "sheet",
      );
    }
    await act(async () => {
      viewport(600);
      window.dispatchEvent(new Event("resize"));
    });
    expect(layout.dataset.sidebarPresentation).toBe("off-canvas");
    expect(layout.style.getPropertyValue("--sidebar-col")).toBe("0px");
    await act(async () => selectionStore.getState().setOpen(false));
    expect(layout.dataset.rightPresentation).toBe("closed");
    expect(layout.style.getPropertyValue("--panel-col")).toBe("0px");
  } finally {
    await shell.cleanup();
    closeSheet();
  }
});

it("names every navigated place in the centre header and keeps it in the document title", async () => {
  const shell = await mountShell();
  const { container } = shell;
  try {
    const place = () => container.querySelector("main header [data-place]")?.textContent;
    const button = (label: string) =>
      [...container.querySelectorAll<HTMLButtonElement>("nav button")].find(
        (item) => item.textContent === label,
      );
    expect(place()).toBe("Today");
    expect(container.querySelector("main h1")?.textContent).toBe("Today");
    expect(container.querySelector("main")?.textContent).toContain(
      "First sweep is reading the program.",
    );
    for (const [label, hash, heading = label] of [
      ["Today", "#today"],
      ["Engineering system", "#engineering-system"],
      ["Environment", "#environment"],
      ["Releases", "#releases"],
    ] as const) {
      await act(async () => button(label)?.click());
      expect(window.location.hash).toBe(hash);
      expect(container.querySelector("main h1")?.textContent).toBe(heading);
      expect(place()).toBe(label);
      expect(document.title).toBe(`SPI Code · ${label}`);
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
      expect(document.title).toBe(`SPI Code · ${label}`);
    }
    expect(button("Releases")?.getAttribute("aria-current")).toBe("true");
    expect(container.querySelector(".title-bar [data-place]")).toBeNull();
    expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe("Detail");
  } finally {
    await shell.cleanup();
    expect(shell.unsubscribe).toHaveBeenCalledTimes(1);
  }
});

it("toggles the sidebar and right panel, omitting the unshipped terminal", async () => {
  const shell = await mountShell();
  const { container } = shell;
  try {
    const toggle = (label: string) =>
      container.querySelector<HTMLButtonElement>(`header button[aria-label="${label}"]`);
    const sidebar = () => container.querySelector<HTMLElement>('nav[aria-label="Sidebar"]');
    for (const label of ["Toggle sidebar", "Toggle right panel"]) {
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

    expect(toggle("Toggle terminal")).toBeNull();
    await press("j");
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    expect(container.querySelector("aside")).not.toBeNull();
  } finally {
    await shell.cleanup();
  }
});

it("opens the sidebar at the off-canvas budget step and closes it on Escape, back to its toggle", async () => {
  viewport(740);
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

it.each([740, 900, 980, 1100, 1280])(
  "opens one detail surface at %i px and restores focus on Escape or close",
  async (width) => {
    viewport(width);
    const previous = watchStore.getState();
    const body = testSnapshot(briefing, releases);
    body.briefing.focus = body.briefing.focus.map((item) => ({
      ...item,
      attention: item.rung === 0 ? "interrupt" : "surface",
    }));
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    const shell = await mountShell();
    const { container } = shell;
    const row = container.querySelector<HTMLButtonElement>("main .place-item-content");
    const trigger = container.querySelector<HTMLButtonElement>(
      'header button[aria-controls="app-right-panel"]',
    );
    try {
      expect(row).not.toBeNull();
      row?.focus();
      await act(async () => row?.click());
      expect(container.querySelectorAll('aside[aria-label="Detail"]')).toHaveLength(1);
      expect(container.querySelector("#app-right-panel")?.hasAttribute("data-sheet")).toBe(
        width < 1032,
      );
      if (width < 1032)
        expect(container.querySelector("#app-right-panel")?.contains(document.activeElement)).toBe(
          true,
        );
      for (const control of container.querySelectorAll<HTMLButtonElement>(
        "#app-right-panel button",
      )) {
        expect(control.getAttribute("aria-label") || control.textContent?.trim()).toBeTruthy();
      }
      container.querySelector<HTMLButtonElement>('#app-right-panel [role="tab"]')?.focus();
      await press("Escape", {});
      expect(container.querySelector("#app-right-panel")).toBeNull();
      expect(document.activeElement).toBe(row);
      trigger?.focus();
      await act(async () => trigger?.click());
      if (width < 1032)
        expect(container.querySelector("#app-right-panel")?.contains(document.activeElement)).toBe(
          true,
        );
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Close detail"]')?.click(),
      );
      expect(container.querySelector("#app-right-panel")).toBeNull();
      expect(document.activeElement).toBe(trigger);
      row?.focus();
      await act(async () => selectionStore.getState().select("halt:legal"));
      await act(async () => selectionStore.getState().clear());
      // PS-11: with nothing selected the panel has nothing to show, at every width.
      expect(container.querySelector("#app-right-panel")).toBeNull();
      expect(document.activeElement).toBe(row);
    } finally {
      await shell.cleanup();
      watchStore.setState(previous);
    }
  },
);

it("keeps a Flow selection on its service and restores centre-body scroll when returning", async () => {
  const previous = watchStore.getState();
  const body = testSnapshot(briefing, releases);
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const flow = body.briefing.flow.rows[0];
  if (!flow) throw new Error("Missing recorded Flow row");
  const shell = await mountShell();
  const bodyScroll = () => {
    const page = shell.container.querySelector<HTMLElement>("main > .service-page");
    if (!page) throw new Error("Missing service scrolling body");
    return page;
  };
  try {
    await act(async () => navigate({ kind: "service", id: flow.fork }));
    await act(async () => selectionStore.getState().select(flow.inspect));
    bodyScroll().scrollTop = 320;
    await act(async () => bodyScroll().dispatchEvent(new Event("scroll")));
    expect(shell.container.querySelector("main")?.scrollTop).toBe(0);
    await act(async () => navigate({ kind: "security" }));
    expect(selectionStore.getState().selected).toBeNull();
    await act(async () => navigate({ kind: "service", id: flow.fork }));
    expect(selectionStore.getState().selected).toBe(flow.inspect);
    expect(bodyScroll().scrollTop).toBe(320);
  } finally {
    await shell.cleanup();
    watchStore.setState(previous);
  }
});

it("keeps the narrow Sidebar and Detail toggles reachable without stacking their overlays", async () => {
  viewport(740);
  selectionStore.setState({ open: false });
  const shell = await mountShell();
  try {
    const sidebar = shell.container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle sidebar"]',
    );
    const detail = shell.container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle right panel"]',
    );
    detail?.focus();
    await act(async () => detail?.click());
    expect(shell.container.querySelector("[data-sheet]")).not.toBeNull();
    sidebar?.focus();
    await act(async () => sidebar?.click());
    expect(shell.container.querySelector("[data-sheet]")).toBeNull();
    expect(shell.container.querySelector('nav[data-state="expanded"]')).not.toBeNull();
    await press("i");
    expect(shell.container.querySelector("[data-sheet]")).not.toBeNull();
    expect(shell.container.querySelector('nav[data-state="expanded"]')).toBeNull();
    await press("b");
    expect(shell.container.querySelector("[data-sheet]")).toBeNull();
    expect(shell.container.querySelector('nav[data-state="expanded"]')).not.toBeNull();
  } finally {
    await shell.cleanup();
  }
});

it("uses Command+B at the off-canvas step and restores focus when the sidebar closes", async () => {
  viewport(740);
  selectionStore.setState({ open: false });
  const platform = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  const shell = await mountShell();
  const toggle = shell.container.querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]');
  const sidebar = shell.container.querySelector<HTMLElement>("#app-sidebar");
  try {
    expect(toggle?.getAttribute("aria-keyshortcuts")).toBe("Meta+B");
    toggle?.focus();
    await press("b", { metaKey: true });
    expect(sidebar?.dataset.mobile).toBe("true");
    expect(sidebar?.dataset.state).toBe("expanded");
    expect(sidebar?.contains(document.activeElement)).toBe(true);
    await press("b", { metaKey: true });
    expect(sidebar?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggle);
    await press("b", { metaKey: true });
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(sidebar?.dataset.state).toBe("collapsed");
    expect(document.activeElement).toBe(toggle);
  } finally {
    await shell.cleanup();
    platform.mockRestore();
  }
});

it("opens the sidebar on the first Command+B after collapsing inline and narrowing to 740 px", async () => {
  selectionStore.setState({ open: false });
  const platform = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Macintosh");
  const shell = await mountShell();
  const toggle = shell.container.querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]');
  const sidebar = shell.container.querySelector<HTMLElement>("#app-sidebar");
  try {
    expect(sidebar?.dataset.mobile).toBeUndefined();
    expect(sidebar?.dataset.state).toBe("expanded");
    toggle?.focus();
    await press("b", { metaKey: true });
    expect(sidebar?.dataset.state).toBe("collapsed");
    await act(async () => {
      viewport(740);
      window.dispatchEvent(new Event("resize"));
    });
    await press("b", { metaKey: true });
    expect(sidebar?.dataset.mobile).toBe("true");
    expect(sidebar?.dataset.state).toBe("expanded");
    expect(sidebar?.hasAttribute("inert")).toBe(false);
    expect(sidebar?.contains(document.activeElement)).toBe(true);
    expect(shell.container.querySelector('[data-slot="sidebar-backdrop"]')).not.toBeNull();
  } finally {
    await shell.cleanup();
    platform.mockRestore();
  }
});

it.each([900, 1280])(
  "closes cleared selection Evidence on navigation only when presented as a sheet at %i px",
  async (width) => {
    viewport(width);
    selectionStore.setState({ open: false });
    const shell = await mountShell();
    try {
      await act(async () => selectionStore.getState().select("repo:legal"));
      await act(async () => selectionStore.getState().openSweepEvidence());
      expect(selectionStore.getState().selected).toBe("repo:legal");
      expect(shell.container.querySelector("#app-right-panel")?.hasAttribute("data-sheet")).toBe(
        width === 900,
      );
      await act(async () => navigate({ kind: "releases" }));
      expect(shell.container.querySelector("main h1")?.textContent).toBe("Releases");
      expect(selectionStore.getState().selected).toBeNull();
      expect(selectionStore.getState().open).toBe(width === 1280);
      expect(shell.container.querySelector("#app-right-panel") !== null).toBe(width === 1280);
      expect(shell.container.querySelector(".detail-backdrop")).toBeNull();
    } finally {
      await shell.cleanup();
    }
  },
);

it("returns sidebar focus to its toggle when resizing hides the inline sidebar", async () => {
  const shell = await mountShell();
  const toggle = shell.container.querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]');
  const sidebar = shell.container.querySelector<HTMLElement>("#app-sidebar");
  try {
    sidebar?.querySelector<HTMLButtonElement>("button")?.focus();
    expect(sidebar?.contains(document.activeElement)).toBe(true);
    await act(async () => {
      viewport(740);
      window.dispatchEvent(new Event("resize"));
    });
    expect(sidebar?.dataset.mobile).toBe("true");
    expect(sidebar?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggle);
  } finally {
    await shell.cleanup();
  }
});

it.each([900, 1280])(
  "keeps a Related selection through snapshot refresh at %i px, but clears a removed listed row",
  async (width) => {
    viewport(width);
    const previous = watchStore.getState();
    const body = testSnapshot(briefing, releases);
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    const item = body.briefing.focus[0];
    if (!item) throw new Error("Missing recorded queue item");
    const relatedId = "step:abc";
    const shell = await mountShell();
    const refresh = async (cursor: number, removeListed = false) =>
      act(async () =>
        watchStore.getState().receive({
          version: PROTOCOL_VERSION,
          id: `snapshot-${cursor}`,
          kind: "event",
          type: "view.snapshot",
          payload: {
            ...body,
            cursor,
            briefing: removeListed
              ? { ...body.briefing, focus: body.briefing.focus.filter(({ id }) => id !== item.id) }
              : body.briefing,
          },
        }),
      );
    try {
      await act(async () => navigate({ kind: "today" }));
      await act(async () => selectionStore.getState().select(item.id));
      await act(async () =>
        selectionStore.getState().receive({
          version: PROTOCOL_VERSION,
          id: selectionStore.getState().request,
          kind: "response",
          type: "inspect.result",
          payload: {
            id: item.id,
            class: item.cls,
            cause: item.cause,
            effect: item.effect,
            next: item.next,
            why: "",
            actions: [],
            evidence: [],
            approval: null,
            related: [{ text: "Template step", state: "waiting", inspect: relatedId }],
          },
        }),
      );
      const related = shell.container.querySelector<HTMLButtonElement>(
        'dl[aria-label="Related"] button',
      );
      expect(related).not.toBeNull();
      await act(async () => related?.click());
      const request = selectionStore.getState().request;
      await refresh(2);
      await refresh(3);
      expect(selectionStore.getState().selected).toBe(relatedId);
      expect(selectionStore.getState().request).toBe(request);
      expect(shell.container.querySelector("#app-right-panel")).not.toBeNull();
      expect(shell.container.querySelector("#app-right-panel")?.hasAttribute("data-sheet")).toBe(
        width < 1032,
      );
      await act(async () => navigate({ kind: "security" }));
      expect(selectionStore.getState().selected).toBeNull();
      await act(async () => navigate({ kind: "today" }));
      await act(async () => selectionStore.getState().select(item.id));
      await refresh(4);
      expect(selectionStore.getState().selected).toBe(item.id);
      await refresh(5, true);
      expect(selectionStore.getState().selected).toBeNull();
      expect(shell.container.querySelector("#app-right-panel")).toBeNull();
    } finally {
      await shell.cleanup();
      watchStore.setState(previous);
    }
  },
);

it.each([900, 1280])(
  "shows selection Evidence areas then repository reads in the detail surface at %i px",
  async (width) => {
    viewport(width);
    const previous = watchStore.getState();
    const body = testSnapshot(briefing, releases);
    const read = (source: string, object: string): ReadRecord => ({
      source,
      object,
      observedAt: body.sweptAt,
      completeness: { kind: "complete" },
    });
    body.reads = [
      read("github", "Azure/osdu-spi-partition"),
      read("Azure/osdu-spi-partition", "fork-runs"),
      read("github", "Azure/osdu-spi-indexer"),
    ];
    const result = InspectResultSchema.parse({
      id: "repo:partition",
      title: "partition",
      class: "SECURITY",
      cause: "Recorded repository reading",
      effect: "",
      next: "",
      why: "",
      evidence: [read("Azure/osdu-spi-partition", "security")],
      related: [],
      approval: null,
      actions: [],
      areas: body.areas.map(({ area }) => ({
        area,
        envelope: {
          source: area,
          state: area === "runs" ? "stale" : "fresh",
          observedAt: body.sweptAt,
          completeness: { kind: "complete" },
        },
      })),
      provenance: [
        { path: "/cause", areas: ["github"] },
        { path: "/next", areas: ["runs"] },
      ],
    });
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    const shell = await mountShell();
    try {
      await act(async () =>
        selectionStore
          .getState()
          .select(result.id, { id: result.id, title: "partition", kind: "repository" }),
      );
      await act(async () =>
        selectionStore.getState().receive({
          version: PROTOCOL_VERSION,
          id: selectionStore.getState().request,
          kind: "response",
          type: "inspect.result",
          payload: result,
        }),
      );
      const panel = shell.container.querySelector("#app-right-panel");
      expect(panel?.hasAttribute("data-sheet")).toBe(width < 1032);
      const chips = panel?.querySelectorAll<HTMLButtonElement>("[data-selection-evidence]");
      expect(chips).toHaveLength(1);
      expect(panel?.querySelector(".detail-title")?.nextElementSibling).toBe(chips?.[0]);
      expect(panel?.querySelector(".inspector [data-selection-evidence]")).toBeNull();
      expect(panel?.querySelectorAll(".evidence-chip")).toHaveLength(1);
      expect(chips?.[0]?.textContent).toContain("stale");
      await act(async () =>
        [...shell.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
          .find((tab) => tab.textContent === "Evidence")
          ?.click(),
      );
      const article = panel?.querySelector('[data-evidence="selection"]');
      expect(
        [...(article?.querySelectorAll("h3") ?? [])].map((heading) => heading.textContent),
      ).toEqual(["Areas", "Reads for partition"]);
      expect(
        [...(article?.querySelectorAll('table[aria-label="Areas"] th') ?? [])].map(
          (heading) => heading.textContent,
        ),
      ).toEqual(["GitHub issues and PRs", "Workflow runs"]);
      expect(
        [...(article?.querySelectorAll('table[aria-label="Reads for partition"] th') ?? [])].map(
          (heading) => heading.textContent,
        ),
      ).toEqual([
        "Azure/osdu-spi-partition · security",
        "GitHub issues and PRs · Azure/osdu-spi-partition",
        "Azure/osdu-spi-partition · fork-runs",
      ]);
      expect(article?.textContent).not.toContain("Azure/osdu-spi-indexer");
      await act(async () =>
        shell.container.querySelector<HTMLButtonElement>('[role="tab"]')?.click(),
      );
      await act(async () =>
        shell.container.querySelector<HTMLButtonElement>("[data-selection-evidence]")?.click(),
      );
      expect(panel?.querySelector('[data-evidence="selection"]')).not.toBeNull();
    } finally {
      await shell.cleanup();
      watchStore.setState(previous);
    }
  },
);

it.each([900, 1280])(
  "opens title-bar sweep Evidence in the detail surface at %i px even with a selection",
  async (width) => {
    viewport(width);
    const previous = watchStore.getState();
    const body = testSnapshot(briefing, releases);
    const item = body.briefing.focus[0];
    if (!item) throw new Error("Missing recorded queue item");
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    const shell = await mountShell();
    try {
      for (const id of [null, item.id]) {
        if (id) await act(async () => selectionStore.getState().select(id));
        await act(async () => selectionStore.getState().setOpen(false));
        expect(shell.container.querySelector("#app-right-panel")).toBeNull();
        await act(async () =>
          shell.container.querySelector<HTMLButtonElement>("header [data-sweep-line]")?.click(),
        );
        const panel = shell.container.querySelector("#app-right-panel");
        expect(panel?.hasAttribute("data-sheet")).toBe(width < 1032);
        expect(panel?.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
          "Evidence",
        );
        const sweep = panel?.querySelector('[data-evidence="sweep"]');
        expect(sweep?.querySelector("h2")?.textContent).toBe("The sweep");
        expect(
          sweep?.querySelectorAll('table[aria-label="Areas"] tr').length,
        ).toBeGreaterThanOrEqual(11);
        expect([...(sweep?.querySelectorAll("h3") ?? [])].map((h) => h.textContent)).toEqual([
          "Areas",
          "Failed reads",
          "API budget",
        ]);
        if (id) expect(selectionStore.getState().selected).toBe(id);
      }
    } finally {
      await shell.cleanup();
      watchStore.setState(previous);
    }
  },
);

it("updates the title-bar sweep line from the live areas with the worst tone, and opens the sweep Evidence", async () => {
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
    const line = () => container.querySelector<HTMLButtonElement>("header [data-sweep-line]");
    expect(line()?.getAttribute("data-tone")).toBe("muted");
    expect(line()?.textContent).toContain("waiting for the first sweep");
    for (const [snapshot, tone, words] of [
      [failed, "bad", "1 failed"],
      [recovered, "muted", null],
      [failed, "muted", null],
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
      expect(line()?.getAttribute("data-tone")).toBe(tone);
      expect(line()?.querySelector("[data-sweep-display]")?.textContent).toMatch(
        /^(\d\d-\d\d )?\d\d:\d\d/,
      );
      const name = document.getElementById(
        line()?.getAttribute("aria-labelledby") ?? "",
      )?.textContent;
      if (words === null) expect(name).toContain("all areas read");
      else expect(name).toContain(words);
      expect(line()?.querySelector("[data-sweep-display]")?.textContent).not.toContain("inferred");
    }
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Toggle right panel"]')?.click(),
    );
    expect(container.querySelector("#app-right-panel")).toBeNull();
    await act(async () => line()?.click());
    const sweep = container.querySelector('#app-right-panel [data-evidence="sweep"]');
    expect(sweep?.querySelectorAll("tr[data-source]").length).toBeGreaterThanOrEqual(11);
    expect(sweep?.textContent).toContain("GitHub issues and PRs");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState(previousState);
    window.spi = previous;
  }
});

it.each(["failed", "stale"] as const)(
  "turns the title-bar freshness glyph on a %s non-area release envelope and clears it on recovery",
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
      const tone = state === "failed" ? "bad" : "warn";
      for (const [snapshot, expected] of [
        [degraded, tone],
        [recovered, "muted"],
        [degraded, "muted"],
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
        const line = container.querySelector("header [data-sweep-line]");
        expect(line?.getAttribute("data-tone")).toBe(expected);
        const name = document.getElementById(
          line?.getAttribute("aria-labelledby") ?? "",
        )?.textContent;
        if (expected === "muted") expect(name).toContain("all areas read");
        else expect(name).toContain(`1 ${state}`);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      watchStore.setState(previousState);
      window.spi = previous;
    }
  },
);

it("shows each pinned snapshot service in the sidebar on every route, as the packaged smoke reads it", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(["smoke-persisted", "smoke-resumed"]));
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
    for (const hash of ["#today", "#environment", "#service/smoke-persisted"]) {
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
    localStorage.removeItem(PINS_STORAGE_KEY);
  }
});
