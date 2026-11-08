// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readdirSync, readFileSync } from "node:fs";
import { ViewSnapshotSchema } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import recorded from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { selectionStore } from "../panels/selection.js";
import { watchStore } from "../store/watch.js";
import { navigate, openSheet, pinSheet, type Registry, type Route } from "./routes.js";
import { Shell } from "./Shell.js";

const styles = readdirSync("apps/window/src", { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".css"))
  .map((file) => ({
    file,
    css: readFileSync(`apps/window/src/${file}`, "utf8"),
  }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function element(container: Element, selector: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
}

async function mount(registry?: Registry) {
  const previousSpi = window.spi;
  const previousWatch = watchStore.getState();
  const previousSelection = selectionStore.getState();
  const previousTheme = document.documentElement.dataset.theme;
  const previousHash = window.location.hash;
  const body = ViewSnapshotSchema.parse(JSON.parse(recorded));
  let receive: Parameters<typeof window.spi.onMessage>[0] | undefined;
  window.location.hash = "#today";
  watchStore.setState({ snapshot: { cursor: body.cursor, body }, setup: null });
  selectionStore.setState({ selected: null, open: false });
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    postMessage: vi.fn(),
    onMessage: (listener) => {
      receive = listener;
      return () => {};
    },
  };
  const style = document.createElement("style");
  style.textContent = styles.map(({ css }) => css).join("\n");
  document.head.append(style);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell {...(registry ? { registry } : {})} />));
  return {
    container,
    receive: (message: unknown) => receive?.(message),
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
      style.remove();
      watchStore.setState(previousWatch, true);
      selectionStore.setState(previousSelection, true);
      window.spi = previousSpi;
      window.location.hash = previousHash;
      if (previousTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = previousTheme;
    },
  };
}

it("does not box bare section selectors anywhere in the window styles", () => {
  for (const { file, css } of styles) {
    for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(?:^|[\s>+~,])section(?=$|[\s>+~,:])/m.test(selector ?? "")) continue;
      expect(declarations, `${file}: ${selector}`).not.toMatch(
        /(?:^|;)\s*(?:background(?:-color)?|border(?:-[\w-]+)?)\s*:/,
      );
    }
  }
});

it("gives every topbar-height reference in window styles a fallback", () => {
  for (const { file, css } of styles) {
    for (const [reference] of css.matchAll(/var\(\s*--topbar-height\b[^)]*\)/g)) {
      expect(reference, file).toMatch(/,\s*[^)\s]/);
    }
  }
});

it.each(["overlay", "pinned"] as const)(
  "uses flush panes with shared headers and bounded centre content beside a %s Line sheet",
  async (presentation) => {
    const view = await mount();
    try {
      await act(async () => {
        navigate({ kind: "service", id: "indexer" });
        selectionStore.getState().openSweepEvidence();
        openSheet();
        if (presentation === "pinned") pinSheet();
      });
      const shell = element(view.container, ".shell");
      const tokens = getComputedStyle(document.documentElement);
      expect(tokens.getPropertyValue("--pane-header-height").trim()).toBe("44px");
      expect(tokens.getPropertyValue("--centre-content-max-width").trim()).toBe("960px");
      expect(tokens.getPropertyValue("--centre-content-padding-block").trim()).toBe("20px");
      expect(tokens.getPropertyValue("--centre-content-padding-inline").trim()).toBe("24px");
      expect(tokens.getPropertyValue("--panel-icon-size").trim()).toBe("24px");
      expect(["", "0px", "normal"]).toContain(getComputedStyle(shell).columnGap);
      for (const selector of [".middle-frame", ".line-sheet", ".right-panel"]) {
        const computed = getComputedStyle(element(view.container, selector));
        expect(computed.padding, selector).toBe("0px");
        expect(["", "0px", "0"]).toContain(computed.borderRadius);
      }
      for (const selector of [".place-header", ".line-toolbar", ".panel-tabs"]) {
        const header = element(view.container, selector);
        expect(header.classList.contains("pane-header"), selector).toBe(true);
        const computed = getComputedStyle(header);
        expect(computed.height, selector).toBe("44px");
        expect(computed.boxSizing, selector).toBe("border-box");
        expect(computed.borderBottomWidth, selector).toBe("1px");
        expect(computed.borderBottomColor, selector).toBe(
          tokens.getPropertyValue("--border").trim(),
        );
      }
      const placeHeader = getComputedStyle(element(view.container, ".place-header"));
      expect(placeHeader.position).toBe("sticky");
      expect(placeHeader.top).toBe("0px");
      const lineBody = element(view.container, ".line-content > .line-body");
      expect(getComputedStyle(lineBody).padding).toBe("20px 24px");
      const lineHeader = getComputedStyle(element(view.container, ".line-toolbar"));
      expect(lineHeader.paddingLeft).toBe("24px");
      expect(lineHeader.paddingRight).toBe("24px");
      expect(lineBody.querySelector(".line-grid")).not.toBeNull();
      expect(view.container.querySelector(".line-toolbar :is(table, fieldset)")).toBeNull();
      expect(getComputedStyle(element(view.container, ".panel-body")).overflow).toBe("auto");
      const close = element(view.container, '[aria-label="Close detail"]');
      expect(close.classList.contains("panel-toggle")).toBe(true);
      expect(getComputedStyle(close).width).toBe("24px");
      expect(getComputedStyle(close).height).toBe("24px");
      for (const name of ["attention", "repository", "release", "runs"]) {
        const header = element(
          view.container,
          `[data-section="${name}"] > .service-section-header`,
        );
        expect(getComputedStyle(header).listStyle).toBe("none");
        const count = element(header, ".service-section-count");
        expect(getComputedStyle(count).marginLeft).toBe("auto");
        const chevron = element(header, ".section-header-chevron");
        expect(getComputedStyle(chevron).transform).toBe(
          name === "attention" ? "rotate(45deg)" : "rotate(-45deg)",
        );
      }
      for (const route of [
        { kind: "service", id: "indexer" },
        { kind: "security" },
        { kind: "releases" },
      ] satisfies Route[]) {
        await act(async () => navigate(route));
        const page = element(view.container, "main > *");
        const computed = getComputedStyle(page);
        expect(computed.padding).toBe("20px 24px");
        for (const content of page.querySelectorAll(
          ":scope > :not(.place, .place-header), .place-reading",
        )) {
          expect(getComputedStyle(content).maxWidth).toBe("960px");
          expect(getComputedStyle(content).marginLeft).not.toBe("auto");
        }
      }
    } finally {
      await view.cleanup();
    }
  },
);

it("keeps the shell error banner inset with the centre's content", async () => {
  const view = await mount();
  try {
    await act(async () => view.receive({ invalid: true }));
    const alert = element(view.container, '.middle-frame > [role="alert"]');
    expect(alert.textContent).toBe("Invalid host message");
    expect(getComputedStyle(alert).padding).toBe("20px 24px 0px");
    expect(getComputedStyle(alert).margin).toBe("0px");
  } finally {
    await view.cleanup();
  }
});

it.each(["light", "dark"])(
  "keeps the centre on surface, the panel on chrome and logical sections flat in %s",
  async (theme) => {
    const view = await mount();
    try {
      document.documentElement.dataset.theme = theme;
      await act(async () => selectionStore.getState().openSweepEvidence());
      const main = element(view.container, "main");
      const panel = element(view.container, "aside");
      const tokens = getComputedStyle(document.documentElement);
      expect(getComputedStyle(document.body).backgroundColor).toBe(
        tokens.getPropertyValue("--surface").trim(),
      );
      expect(getComputedStyle(main).backgroundColor).toBe(
        tokens.getPropertyValue("--surface").trim(),
      );
      expect(getComputedStyle(panel).backgroundColor).toBe(
        tokens.getPropertyValue("--chrome").trim(),
      );
      const routes: Route[] = [
        { kind: "today" },
        { kind: "upstream" },
        { kind: "environment" },
        { kind: "engineering-system" },
        { kind: "releases" },
        { kind: "security" },
        { kind: "service", id: "indexer" },
        { kind: "release", month: "2026-11" },
      ];
      let cards = 0;
      for (const route of routes) {
        await act(async () => navigate(route));
        for (const section of view.container.querySelectorAll("main section")) {
          const computed = getComputedStyle(section);
          if (section.classList.contains("card")) {
            cards++;
            expect(computed.backgroundColor).toBe(tokens.getPropertyValue("--surface").trim());
            expect(computed.borderTopWidth).toBe("1px");
            expect(computed.borderRadius).toBe("8px");
          } else {
            expect(["", "transparent", "rgba(0, 0, 0, 0)"]).toContain(computed.backgroundColor);
            expect(["", "0px"]).toContain(computed.borderTopWidth);
            expect(["", "0px", "0"]).toContain(computed.borderRadius);
          }
        }
      }
      expect(cards).toBeGreaterThan(0);
      expect(view.container.querySelectorAll("main section.card")).toHaveLength(0);
    } finally {
      await view.cleanup();
    }
  },
);

it.each([true, false])(
  "offsets narrow sheets and backdrops by the measured top row with strip=%s",
  async (withStrip) => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight };
    type HappyWindow = {
      happyDOM: { setViewport(viewport: { width: number; height: number }): void };
    };
    const dom = (window as unknown as HappyWindow).happyDOM;
    dom.setViewport({ width: 740, height: 900 });
    let titleHeight = 44;
    const rect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches(".title-bar")) return DOMRect.fromRect({ height: titleHeight });
      return rect.call(this);
    });
    let measure: (() => void) | undefined;
    const disconnect = vi.fn();
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          measure = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect = disconnect;
      },
    );
    const view = await mount({
      views: { today: () => <h1>Today</h1> },
      fallback: { kind: "today" },
      ...(withStrip ? { strip: () => <p>Line status</p> } : {}),
    });
    try {
      const sidebarToggle = view.container.querySelector<HTMLButtonElement>(
        '[aria-label="Toggle sidebar"]',
      );
      await act(async () => {
        sidebarToggle?.click();
        selectionStore.getState().openSweepEvidence();
      });
      const shell = view.container.querySelector<HTMLElement>(".shell");
      const assertOffsets = (height: number) => {
        expect(shell?.style.getPropertyValue("--topbar-height")).toBe(`${height}px`);
        for (const selector of [
          ".app-sidebar",
          ".sidebar-backdrop",
          ".right-panel-frame",
          ".detail-backdrop",
        ]) {
          const computed = getComputedStyle(element(view.container, selector));
          const offset = selector.endsWith("backdrop")
            ? computed.inset.split(" ")[0]
            : computed.top;
          expect(offset, selector).toBe(`${height}px`);
        }
      };
      assertOffsets(44);
      expect(observed.map((element) => element.className)).toEqual(["title-bar"]);
      titleHeight = 75;
      await act(async () => measure?.());
      assertOffsets(75);
    } finally {
      await view.cleanup();
      dom.setViewport(previousViewport);
      expect(disconnect).toHaveBeenCalledOnce();
    }
  },
);
