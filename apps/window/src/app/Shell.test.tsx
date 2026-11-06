// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { InspectResultSchema, PROTOCOL_VERSION, type ReadRecord } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { selectionStore } from "../panels/selection.js";
import { testSnapshot } from "../store/test-snapshot.js";
import { watchStore } from "../store/watch.js";
import { navigate } from "./routes.js";
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
    expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe("Detail");
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

it.each([900, 979, 980, 1280])(
  "opens one detail surface at %i px and restores focus on Escape or close",
  async (width) => {
    viewport(width);
    const previous = watchStore.getState();
    const body = testSnapshot(briefing, releases);
    watchStore.setState({ snapshot: { cursor: body.cursor, body } });
    const shell = await mountShell();
    const { container } = shell;
    const row = container.querySelector<HTMLButtonElement>("main .inbox-row-title");
    const trigger = container.querySelector<HTMLButtonElement>(
      'header button[aria-controls="app-right-panel"]',
    );
    try {
      expect(row).not.toBeNull();
      if (width < 980) expect(container.querySelector("#app-right-panel")).toBeNull();
      row?.focus();
      await act(async () => row?.click());
      expect(container.querySelectorAll('aside[aria-label="Detail"]')).toHaveLength(1);
      expect(container.querySelector("#app-right-panel")?.hasAttribute("data-sheet")).toBe(
        width < 980,
      );
      if (width < 980)
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
      if (width < 980)
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
      expect(container.querySelector("#app-right-panel") === null).toBe(width < 980);
      expect(document.activeElement).toBe(row);
    } finally {
      await shell.cleanup();
      watchStore.setState(previous);
    }
  },
);

it("keeps a Flow selection on its service and restores middle-frame scroll when returning", async () => {
  const previous = watchStore.getState();
  const body = testSnapshot(briefing, releases);
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const flow = body.briefing.flow.rows[0];
  if (!flow) throw new Error("Missing recorded Flow row");
  const shell = await mountShell();
  const middle = shell.container.querySelector("main");
  try {
    await act(async () => navigate({ kind: "lens", lens: "flow" }));
    await act(async () => selectionStore.getState().select(flow.inspect));
    if (!middle) throw new Error("Missing middle frame");
    middle.scrollTop = 320;
    await act(async () => middle.dispatchEvent(new Event("scroll")));
    await act(async () => navigate({ kind: "service", id: flow.fork }));
    expect(selectionStore.getState().selected).toBe(flow.inspect);
    expect(middle.scrollTop).toBe(0);
    await act(async () => navigate({ kind: "setup" }));
    expect(selectionStore.getState().selected).toBeNull();
    await act(async () => navigate({ kind: "lens", lens: "flow" }));
    expect(selectionStore.getState().selected).toBe(flow.inspect);
    expect(middle.scrollTop).toBe(320);
  } finally {
    await shell.cleanup();
    watchStore.setState(previous);
  }
});

it("keeps the narrow Sidebar and Detail toggles reachable without stacking their overlays", async () => {
  viewport(900);
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
      await act(async () => navigate({ kind: "inbox" }));
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
        'ul[aria-label="Related"] button',
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
        width < 980,
      );
      await act(async () => navigate({ kind: "setup" }));
      expect(selectionStore.getState().selected).toBeNull();
      await act(async () => navigate({ kind: "inbox" }));
      await act(async () => selectionStore.getState().select(item.id));
      await refresh(4);
      expect(selectionStore.getState().selected).toBe(item.id);
      await refresh(5, true);
      expect(selectionStore.getState().selected).toBeNull();
      expect(shell.container.querySelector("#app-right-panel") === null).toBe(width < 980);
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
      expect(panel?.hasAttribute("data-sheet")).toBe(width < 980);
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
        expect(panel?.hasAttribute("data-sheet")).toBe(width < 980);
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
      [failed, "bad", "1 area failed"],
      [recovered, "fresh", "all fresh"],
      [failed, "fresh", "all fresh"],
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
      expect(line()?.textContent).toContain(words);
      expect(line()?.textContent).not.toContain("inferred");
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
  "turns the title-bar sweep line on a %s non-area release envelope and clears it on recovery",
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
        const line = container.querySelector("header [data-sweep-line]");
        expect(line?.getAttribute("data-tone")).toBe(expected);
        expect(line?.textContent).toContain(
          expected === "fresh"
            ? "all fresh"
            : `release lines ${state === "failed" ? "read failed" : "stale"}`,
        );
        expect(line?.textContent).not.toMatch(/\d+ areas? (failed|stale)/);
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

it("restores a saved Dark pin into the caption controls at startup and follows the Appearance menu", async () => {
  localStorage.setItem("spi-code.appearance", "dark");
  const shell = await mountShell();
  try {
    const menu = shell.container.querySelector<HTMLSelectElement>("select[aria-label=Appearance]");
    if (!menu) throw new Error("Missing Appearance menu");
    const choose = (value: string) =>
      act(async () => {
        menu.value = value;
        menu.dispatchEvent(new Event("change", { bubbles: true }));
      });
    expect(shell.spi.setAppearance).toHaveBeenLastCalledWith("dark");
    await choose("light");
    expect(shell.spi.setAppearance).toHaveBeenLastCalledWith("light");
    await choose("system");
    expect(shell.spi.setAppearance).toHaveBeenLastCalledWith(
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    );
  } finally {
    await shell.cleanup();
    localStorage.removeItem("spi-code.appearance");
  }
});
