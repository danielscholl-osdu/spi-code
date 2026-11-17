// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { after, midSweep, SWEEP_START, sweepStatus } from "../components/sweep/test-helper.js";
import { selectionStore } from "../panels/selection.js";
import { PINS_STORAGE_KEY } from "../store/pins.js";
import { testSnapshot } from "../store/test-snapshot.js";
import { watchStore } from "../store/watch.js";
import { installSpi } from "../test-utils/harness.js";
import { PANES_STORAGE_KEY } from "./pane-layout.js";
import {
  closeSheet,
  navigate,
  openEvidence,
  pinSheet,
  type Registry,
  type Route,
} from "./routes.js";
import { Shell } from "./Shell.js";
import { PaneTitle } from "./title-row.js";

type HappyWindow = { happyDOM: { setViewport(viewport: { width: number; height: number }): void } };
const viewport = (width: number, height = 900) =>
  (window as unknown as HappyWindow).happyDOM.setViewport({ width, height });

async function mountShell() {
  const unsubscribe = vi.fn();
  const harness = installSpi({
    setAppearance: vi.fn(async () => true),
    onMessage: () => unsubscribe,
  });
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
      harness.restore();
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
  });
});

it.each(["failed", "cancelled"] as const)(
  "opens the Evidence page onto the same %s first-sweep state as Today",
  async (outcome) => {
    vi.useFakeTimers({ now: SWEEP_START + 130_000, toFake: ["Date"] });
    const previous = watchStore.getState();
    watchStore.setState({
      snapshot: null,
      setup: null,
      progress:
        outcome === "cancelled"
          ? midSweep({ outcome })
          : {
              ...midSweep(),
              outcome,
              code: "timeout",
              failure: "GitHub did not answer in time.",
              source: "runs",
              nextAttemptAt: after(420),
            },
      sweep: sweepStatus({ nextSweepAt: after(420) }),
    });
    selectionStore.getState().setOpen(false);
    const shell = await mountShell();
    try {
      expect(selectionStore.getState().selected).toBeNull();
      expect(shell.container.querySelector("#app-right-panel")).toBeNull();
      const today = shell.container.querySelector("main .today-first")?.outerHTML;
      await act(async () => openEvidence(null));
      const evidence = shell.container.querySelector('.evidence-page [data-evidence="sweep"]');
      expect(evidence?.querySelector(".today-first")?.outerHTML).toBe(today);
      expect(evidence?.querySelector("h2")?.textContent).toBe("The first sweep stopped.");
      expect(evidence?.textContent).not.toContain("Waiting for the first sweep");
      await act(async () =>
        evidence?.querySelector<HTMLButtonElement>(".today-first-actions button")?.click(),
      );
      expect(shell.spi.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "sweep.request", payload: {} }),
      );
    } finally {
      await shell.cleanup();
      watchStore.setState(previous, true);
      vi.useRealTimers();
    }
  },
);

it("re-decides the pane presentations and widths through all eight drawn cases", async () => {
  const shell = await mountShell();
  const layout = shell.container.querySelector<HTMLElement>(".shell");
  if (!layout) throw new Error("Missing shell");
  try {
    for (const [width, pinned, centre, sidebar, line, lineWidth, detail, detailWidth] of [
      [1600, false, 1368, "inline", "closed", 0, "closed", 0],
      [1440, true, 848, "inline", "inline", 360, "closed", 0],
      [1280, true, 688, "inline", "inline", 360, "closed", 0],
      [1100, false, 868, "inline", "closed", 0, "closed", 0],
      [1100, true, 520, "inline", "inline", 348, "closed", 0],
      [980, false, 748, "inline", "closed", 0, "closed", 0],
      [900, true, 668, "inline", "stacked", 668, "closed", 0],
      [740, false, 740, "off-canvas", "closed", 0, "closed", 0],
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
      expect(layout.style.getPropertyValue("--panel-col")).toBe("0px");
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
      expect(
        shell.container.querySelector("#app-right-panel, [aria-controls=app-right-panel]"),
      ).toBeNull();
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
    expect(container.querySelectorAll("[data-place]")).toHaveLength(1);
    expect(container.querySelector("#app-right-panel")).toBeNull();
  } finally {
    await shell.cleanup();
    expect(shell.unsubscribe).toHaveBeenCalledTimes(1);
  }
});

it("toggles the sidebar with no right panel outside a thread, omitting the unshipped terminal", async () => {
  const shell = await mountShell();
  const { container } = shell;
  try {
    const toggle = (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    const sidebar = () => container.querySelector<HTMLElement>('nav[aria-label="Sidebar"]');
    for (const label of ["Toggle sidebar"]) {
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

    expect(container.querySelector("#app-right-panel")).toBeNull();
    expect(toggle("Toggle right panel")).toBeNull();
    await press("i");
    expect(container.querySelector("#app-right-panel")).toBeNull();

    expect(toggle("Toggle terminal")).toBeNull();
    await press("j");
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    expect(container.querySelector("#app-right-panel")).toBeNull();
  } finally {
    await shell.cleanup();
  }
});

it("shows the mounted view's title, chips and Pin in the shell's title row, and only the route's name when a view gives none", async () => {
  const titled = (route: Route) => (
    <section data-view={route.kind}>
      <PaneTitle>
        <h1 data-place>Titled</h1>
        <button type="button">Chip</button>
      </PaneTitle>
      <p>body</p>
    </section>
  );
  const plain = (route: Route) => <section data-view={route.kind}>plain body</section>;
  const registry: Registry = {
    views: { today: titled, upstream: plain },
    fallback: { kind: "today" },
  };
  const harness = installSpi({ onMessage: () => vi.fn() });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Shell registry={registry} />));
    const title = () => container.querySelector(".centre-bar .centre-title");
    expect(title()?.querySelector("h1")?.textContent).toBe("Titled");
    expect(title()?.querySelector("button")?.textContent).toBe("Chip");
    expect(container.querySelector(".centre-body header")).toBeNull();
    expect(container.querySelector(".centre-body [data-view] > p")?.textContent).toBe("body");
    await act(async () => navigate({ kind: "upstream" }));
    expect(title()?.querySelector("h1")?.textContent).toBe("Upstream");
    expect(title()?.querySelector("button")).toBeNull();
    expect(container.querySelectorAll("[data-place]")).toHaveLength(1);
    await act(async () => navigate({ kind: "today" }));
    expect(title()?.querySelector("h1")?.textContent).toBe("Titled");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    harness.restore();
  }
});

it("opens the sidebar at the off-canvas budget step and closes it on Escape, back to its toggle", async () => {
  viewport(740);
  const shell = await mountShell();
  const { container } = shell;
  try {
    const sidebar = () => container.querySelector<HTMLElement>('nav[aria-label="Sidebar"]');
    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle sidebar"]',
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

it("restores centre-body scroll when returning to a service", async () => {
  const previous = watchStore.getState();
  const body = testSnapshot(briefing, releases);
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const flow = body.briefing.flow.rows[0];
  if (!flow) throw new Error("Missing recorded Flow row");
  const shell = await mountShell();
  const bodyScroll = () => {
    const page = shell.container.querySelector<HTMLElement>(".centre-body > .service-page");
    if (!page) throw new Error("Missing service scrolling body");
    return page;
  };
  try {
    await act(async () => navigate({ kind: "service", id: flow.fork }));
    bodyScroll().scrollTop = 320;
    await act(async () => bodyScroll().dispatchEvent(new Event("scroll")));
    expect(shell.container.querySelector("main")?.scrollTop).toBe(0);
    await act(async () => navigate({ kind: "security" }));
    await act(async () => navigate({ kind: "service", id: flow.fork }));
    expect(bodyScroll().scrollTop).toBe(320);
  } finally {
    await shell.cleanup();
    watchStore.setState(previous);
  }
});

it("keeps the narrow sidebar reachable and ignores the right-panel shortcut outside a thread", async () => {
  viewport(740);
  const shell = await mountShell();
  try {
    const sidebar = shell.container.querySelector<HTMLButtonElement>(
      '[aria-label="Toggle sidebar"]',
    );
    sidebar?.focus();
    await act(async () => sidebar?.click());
    expect(shell.container.querySelector('nav[data-state="expanded"]')).not.toBeNull();
    await press("i");
    expect(
      shell.container.querySelector("#app-right-panel, [aria-controls=app-right-panel]"),
    ).toBeNull();
    expect(shell.container.querySelector('nav[data-state="expanded"]')).not.toBeNull();
    await press("b");
    expect(shell.container.querySelector('nav[data-state="expanded"]')).toBeNull();
    expect(document.activeElement).toBe(sidebar);
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

it.each([600, 1280])(
  "keeps a running sweep's line with the sidebar out of sight at %i px",
  async (width) => {
    viewport(width);
    const previous = watchStore.getState();
    watchStore.setState({ progress: null });
    const shell = await mountShell();
    try {
      if (width === 1280)
        await act(async () =>
          shell.container
            .querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]')
            ?.click(),
        );
      const sidebar = shell.container.querySelector("#app-sidebar");
      expect(sidebar?.getAttribute("data-state")).toBe("collapsed");
      expect(sidebar?.hasAttribute("data-mobile")).toBe(width === 600);
      await act(async () => watchStore.setState({ progress: midSweep() }));
      const line = shell.container.querySelector<HTMLElement>("[data-sweep-progress]");
      expect(line?.dataset.sweepProgress).toBe("0.75");
      expect(line?.closest("#app-sidebar")).toBeNull();
      expect(shell.container.querySelector(".centre-bar [data-sweep-line]")).toBeNull();
      await act(async () => watchStore.setState({ progress: null }));
      expect(shell.container.querySelector("[data-sweep-progress]")).toBeNull();
    } finally {
      await shell.cleanup();
      watchStore.setState(previous, true);
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
  "opens the footer sweep Evidence as the whole sweep's page at %i px even with a selection",
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
          shell.container
            .querySelector<HTMLButtonElement>("[data-slot=sidebar-footer] [data-sweep-line]")
            ?.click(),
        );
        await act(async () =>
          document
            .querySelector<HTMLButtonElement>("[data-sweep-popover] .capsule-evidence")
            ?.click(),
        );
        expect(shell.container.querySelector("#app-right-panel")).toBeNull();
        expect(window.location.hash).toMatch(/^#evidence(\?from=today)?$/);
        const sweep = shell.container.querySelector('.centre-body [data-evidence="sweep"]');
        expect(sweep?.querySelector("h2")?.textContent).toBe("The sweep");
        expect(sweep?.querySelector('table[aria-label="Areas"]')).toBeNull();
        expect(sweep?.querySelectorAll(".sweep-row[data-source]").length).toBeGreaterThanOrEqual(
          11,
        );
        expect([...(sweep?.querySelectorAll("h3") ?? [])].map((h) => h.textContent)).toEqual([
          "Sources",
        ]);
        await act(async () =>
          shell.container.querySelector<HTMLButtonElement>("[data-evidence-back]")?.click(),
        );
        expect(window.location.hash).toBe("#today");
        if (id) expect(selectionStore.getState().selected).toBe(id);
      }
    } finally {
      await shell.cleanup();
      watchStore.setState(previous);
    }
  },
);

it("closes the off-canvas sidebar under the Evidence the footer sweep opens", async () => {
  viewport(740);
  const previous = watchStore.getState();
  const body = testSnapshot(briefing, releases);
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const shell = await mountShell();
  try {
    const sidebar = () => shell.container.querySelector<HTMLElement>('nav[aria-label="Sidebar"]');
    await act(async () =>
      shell.container
        .querySelector<HTMLButtonElement>('button[aria-label="Toggle sidebar"]')
        ?.click(),
    );
    expect(sidebar()?.getAttribute("data-state")).toBe("expanded");
    await act(async () =>
      shell.container
        .querySelector<HTMLButtonElement>("[data-slot=sidebar-footer] [data-sweep-line]")
        ?.click(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-sweep-popover] .capsule-evidence")?.click(),
    );
    expect(sidebar()?.getAttribute("data-state")).toBe("collapsed");
    expect(shell.container.querySelector('[data-slot="sidebar-backdrop"]')).toBeNull();
    expect(shell.container.querySelector('.centre-body [data-evidence="sweep"]')).not.toBeNull();
  } finally {
    await shell.cleanup();
    watchStore.setState(previous);
  }
});

it("updates the footer sweep from the live areas with the worst tone, and opens the sweep Evidence", async () => {
  const previousState = watchStore.getState();
  let receive: Parameters<typeof window.spi.onMessage>[0] | undefined;
  const harness = installSpi({
    onMessage: (listener) => {
      receive = listener;
      return vi.fn();
    },
  });
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
    const line = () =>
      container.querySelector<HTMLButtonElement>("[data-slot=sidebar-footer] [data-sweep-line]");
    expect(line()?.getAttribute("data-tone")).toBe("fine");
    expect(line()?.textContent).toContain("Waiting for the first sweep");
    for (const [snapshot, tone, words] of [
      [failed, "bad", "1 failed"],
      [recovered, "fine", null],
      [failed, "fine", null],
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
    expect(container.querySelector("#app-right-panel")).toBeNull();
    await act(async () => line()?.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-sweep-popover] .capsule-evidence")?.click(),
    );
    const sweep = container.querySelector('.centre-body [data-evidence="sweep"]');
    expect(sweep?.querySelectorAll(".sweep-row[data-source]").length).toBeGreaterThanOrEqual(11);
    expect(sweep?.textContent).toContain("GitHub issues and PRs");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    watchStore.setState(previousState);
    harness.restore();
  }
});

it.each(["failed", "stale"] as const)(
  "turns the footer sweep on a %s non-area release envelope and clears it on recovery",
  async (state) => {
    const previousState = watchStore.getState();
    let receive: Parameters<typeof window.spi.onMessage>[0] | undefined;
    const harness = installSpi({
      onMessage: (listener) => {
        receive = listener;
        return vi.fn();
      },
    });
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
        { path: "/releases/lines", areas: ["fleet"], envelope: releaseEnvelope },
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
        [recovered, "fine"],
        [degraded, "fine"],
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
        const line = container.querySelector("[data-slot=sidebar-footer] [data-sweep-line]");
        expect(line?.getAttribute("data-tone")).toBe(expected);
        const name = document.getElementById(
          line?.getAttribute("aria-labelledby") ?? "",
        )?.textContent;
        if (expected === "fine") expect(name).toContain("all areas read");
        else expect(name).toContain(`1 ${state}`);
      }
    } finally {
      await act(async () => root.unmount());
      container.remove();
      watchStore.setState(previousState);
      harness.restore();
    }
  },
);

it("shows each pinned snapshot service in the sidebar on every route, as the packaged smoke reads it", async () => {
  localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(["smoke-persisted", "smoke-resumed"]));
  const previousState = watchStore.getState();
  let receive: Parameters<typeof window.spi.onMessage>[0] | undefined;
  const harness = installSpi({
    onMessage: (listener) => {
      receive = listener;
      return vi.fn();
    },
  });
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
    harness.restore();
    localStorage.removeItem(PINS_STORAGE_KEY);
  }
});

it("opens the sweep's Evidence when desktop main routes the tray's View sweep, and ignores other places", async () => {
  const previousState = watchStore.getState();
  let route: ((destination: unknown) => void) | undefined;
  const unroute = vi.fn();
  const harness = installSpi({
    onMessage: () => vi.fn(),
    onNavigate: (listener) => {
      route = listener;
      return unroute;
    },
  });
  watchStore.setState({ snapshot: { cursor: 1, body: testSnapshot(briefing, releases) } });
  selectionStore.setState({ open: false });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Shell />));
    expect(container.querySelector("#app-right-panel")).toBeNull();
    for (const destination of [{ to: "settings" }, { to: "evidence", item: "x" }, "evidence"])
      await act(async () => route?.(destination));
    expect(container.querySelector("#app-right-panel")).toBeNull();
    await act(async () => route?.({ to: "evidence" }));
    expect(window.location.hash).toBe("#evidence");
    expect(container.querySelector("#app-right-panel")).toBeNull();
    const sweep = container.querySelector(".evidence-page");
    expect(sweep?.querySelector("[data-evidence-whole]")).toBeNull();
    expect(sweep?.querySelectorAll(".sweep-row[data-source]").length).toBeGreaterThanOrEqual(11);
    await act(async () => navigate({ kind: "environment" }));
    const item = watchStore.getState().snapshot?.body.briefing.focus[0];
    if (!item) throw new Error("Missing recorded item");
    await act(async () => route?.({ to: "today", item: item.id }));
    expect(window.location.hash).toBe("#today");
    expect(container.querySelector("main h1")?.textContent).toBe("Today");
    expect(selectionStore.getState()).toMatchObject({ selected: null, open: false });
  } finally {
    await act(async () => root.unmount());
    expect(unroute).toHaveBeenCalledOnce();
    container.remove();
    watchStore.setState(previousState);
    harness.restore();
  }
});

it("closes Settings before View sweep opens the sweep's Evidence, and opens Readiness for a can't-read click", async () => {
  const previousState = watchStore.getState();
  let route: ((destination: unknown) => void) | undefined;
  const harness = installSpi({
    onMessage: () => vi.fn(),
    onNavigate: (listener) => {
      route = listener;
      return vi.fn();
    },
  });
  watchStore.setState({ snapshot: { cursor: 1, body: testSnapshot(briefing, releases) } });
  selectionStore.setState({ open: false });
  const agent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh)");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const settings = () => document.querySelector('[role="dialog"]');
  try {
    await act(async () => root.render(<Shell />));
    await act(async () => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(settings()).not.toBeNull();
    await act(async () => route?.({ to: "settings" }));
    expect(settings()).not.toBeNull();
    await act(async () => route?.({ to: "evidence" }));
    expect(settings()).toBeNull();
    const evidence = container.querySelector(".evidence-page");
    expect(evidence).not.toBeNull();
    expect(evidence?.closest("[inert], [aria-hidden='true']")).toBeNull();

    const section = () =>
      document.querySelector("[data-settings-section]")?.getAttribute("data-settings-section");
    await act(async () => route?.({ to: "readiness" }));
    expect(settings()).not.toBeNull();
    expect(section()).toBe("readiness");
    const sweepButton = [
      ...document.querySelectorAll<HTMLButtonElement>(".settings-nav-item"),
    ].find((button) => button.textContent === "Sweep");
    await act(async () => sweepButton?.click());
    expect(section()).toBe("sweep");
    await act(async () => route?.({ to: "readiness" }));
    expect(section()).toBe("readiness");
  } finally {
    await act(async () => root.unmount());
    agent.mockRestore();
    container.remove();
    watchStore.setState(previousState);
    harness.restore();
  }
});
