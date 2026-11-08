// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import type { SetupState } from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import { navigate } from "../app/routes.js";
import { Shell } from "../app/Shell.js";
import { selectionStore } from "../panels/selection.js";
import { testSnapshot } from "../store/test-snapshot.js";
import { watchStore } from "../store/watch.js";

type HappyWindow = { happyDOM: { setViewport(viewport: { width: number; height: number }): void } };
const viewport = (width: number, height = 900) =>
  (window as unknown as HappyWindow).happyDOM.setViewport({ width, height });

const previousStore = watchStore.getState();

async function mountShell() {
  const previous = window.spi;
  window.spi = {
    proof: false,
    openExternal: vi.fn(),
    setAppearance: vi.fn(async () => true),
    postMessage: vi.fn(),
    onMessage: () => () => {},
  };
  const spi = window.spi;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Shell />));
  return {
    container,
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
    (document.activeElement ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
    );
  });
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const section = () => dialog()?.querySelector<HTMLElement>("[data-settings-section]");
const navItem = (label: string) =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>(".settings-nav button") ?? [])].find(
    (button) => button.textContent === label,
  );
const close = () =>
  act(async () =>
    dialog()?.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')?.click(),
  );
const tools = (states: SetupState["tools"][number]["state"][]): SetupState => {
  const ready = states.every((state) => state === "ready");
  return {
    watchReady: ready,
    disabledReason: ready ? null : "gh is not signed in",
    tools: (["copilot", "git", "gh", "glab"] as const).map((tool, index) => ({
      tool,
      state: states[index] ?? "ready",
      action: null,
    })),
  };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "";
  viewport(1280);
  watchStore.setState({ setup: tools(["ready", "ready", "ready", "ready"]) });
});

afterEach(() => {
  vi.unstubAllGlobals();
  watchStore.setState(previousStore);
  localStorage.removeItem("spi-code.appearance");
});

it("opens on Cmd-comma over the current place, on the last section viewed, and closes on Escape", async () => {
  const shell = await mountShell();
  try {
    expect(dialog()).toBeNull();
    await press(",");
    expect(dialog()?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(
      document.getElementById(dialog()?.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toBe("Settings");
    expect(section()?.dataset.settingsSection).toBe("readiness");
    expect(section()?.querySelector("h1")?.textContent).toBe("Setup");
    expect(navItem("Readiness")?.getAttribute("aria-current")).toBe("page");
    await act(async () => navItem("Appearance")?.click());
    expect(section()?.dataset.settingsSection).toBe("appearance");
    expect(dialog()?.querySelector(".settings-crumb")?.textContent).toBe("Settings / Appearance");
    await press("Escape", {});
    expect(dialog()).toBeNull();
    expect(shell.container.querySelector("header [data-place]")?.textContent).toBe("Today");
    await press(",");
    expect(section()?.dataset.settingsSection).toBe("appearance");
    await act(async () => navItem("Readiness")?.click());
    await close();
    await press(",");
    expect(section()?.dataset.settingsSection).toBe("readiness");
    await close();
  } finally {
    await shell.cleanup();
  }
});

it("moves focus into the dialog on open and back to where it was on close", async () => {
  const shell = await mountShell();
  try {
    const opener = shell.container.querySelector<HTMLButtonElement>(
      'header button[aria-label="Toggle right panel"]',
    );
    opener?.focus();
    expect(document.activeElement).toBe(opener);
    await press(",");
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    await press("Escape", {});
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    await press(",");
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    await close();
    expect(document.activeElement).toBe(opener);
  } finally {
    await shell.cleanup();
  }
});

it("leaves the route, selection and scroll behind it unchanged when it closes", async () => {
  const body = testSnapshot(briefing, releases);
  watchStore.setState({ snapshot: { cursor: body.cursor, body } });
  const flow = body.briefing.flow.rows[0];
  if (!flow) throw new Error("Missing recorded Flow row");
  const shell = await mountShell();
  try {
    await act(async () => navigate({ kind: "service", id: flow.fork }));
    await act(async () => selectionStore.getState().select(flow.inspect));
    const middle = shell.container.querySelector("main");
    if (!middle) throw new Error("Missing middle frame");
    middle.scrollTop = 240;
    await act(async () => middle.dispatchEvent(new Event("scroll")));
    const hash = window.location.hash;
    for (const shut of [() => press("Escape", {}), close]) {
      await press(",");
      expect(dialog()).not.toBeNull();
      await shut();
      expect(dialog()).toBeNull();
      expect(window.location.hash).toBe(hash);
      expect(shell.container.querySelector("header [data-place]")?.textContent).toBe(flow.fork);
      expect(selectionStore.getState().selected).toBe(flow.inspect);
      expect(selectionStore.getState().open).toBe(true);
      expect(middle.scrollTop).toBe(240);
    }
  } finally {
    await shell.cleanup();
    selectionStore.getState().clear();
  }
});

it.each([740, 759])("folds the section nav into a header picker at %i px", async (width) => {
  viewport(width);
  const shell = await mountShell();
  try {
    await press(",");
    const picker = dialog()?.querySelector<HTMLSelectElement>(
      'header select[aria-label="Settings section"]',
    );
    expect(dialog()?.dataset.layout).toBe("picker");
    expect(dialog()?.querySelector(".settings-nav")).toBeNull();
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    expect(picker?.value).toBe("readiness");
    expect([...(picker?.options ?? [])].map((option) => option.textContent)).toEqual([
      "Readiness",
      "Appearance",
    ]);
    await act(async () => {
      if (!picker) return;
      picker.value = "appearance";
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(section()?.dataset.settingsSection).toBe("appearance");
    await close();
    viewport(760);
    await press(",");
    expect(dialog()?.dataset.layout).toBe("nav");
    expect(dialog()?.querySelector('select[aria-label="Settings section"]')).toBeNull();
    expect(navItem("Appearance")?.getAttribute("aria-current")).toBe("page");
    await close();
  } finally {
    await shell.cleanup();
  }
});

it("marks the Readiness nav item amber when a tool needs attention and red when one failed", async () => {
  const shell = await mountShell();
  try {
    await press(",");
    const dot = () => navItem("Readiness")?.querySelector<HTMLElement>(".settings-dot");
    expect(dot()).toBeNull();
    await act(async () => watchStore.setState({ setup: tools(["ready", "ready", "installing"]) }));
    expect(dot()).toBeNull();
    await act(async () => watchStore.setState({ setup: tools(["ready", "ready", "signed-out"]) }));
    expect(dot()?.dataset.readiness).toBe("attention");
    expect(dot()?.getAttribute("aria-label")).toBe("A tool needs attention");
    await act(async () =>
      watchStore.setState({ setup: tools(["ready", "ready", "signed-out", "failed"]) }),
    );
    expect(dot()?.dataset.readiness).toBe("failure");
    expect(dot()?.getAttribute("aria-label")).toBe("A tool failed");
    await act(async () => watchStore.setState({ setup: null }));
    expect(dot()).toBeNull();
    expect(navItem("Appearance")?.querySelector(".settings-dot")).toBeNull();
    await close();
    viewport(740);
    watchStore.setState({ setup: tools(["missing"]) });
    await press(",");
    expect(
      dialog()?.querySelector<HTMLElement>(".settings-picker .settings-dot")?.dataset.readiness,
    ).toBe("attention");
    await close();
  } finally {
    await shell.cleanup();
  }
});

it("changes the theme from Appearance in the dialog, and the title bar has no Appearance control", async () => {
  localStorage.setItem("spi-code.appearance", "dark");
  const shell = await mountShell();
  try {
    expect(shell.container.querySelector("header")?.textContent).not.toContain("Appearance");
    expect(shell.container.querySelector("header select")).toBeNull();
    expect(shell.spi.setAppearance).toHaveBeenLastCalledWith("dark");
    await press(",");
    await act(async () => navItem("Appearance")?.click());
    const radio = (label: string) =>
      [...(section()?.querySelectorAll<HTMLLabelElement>(".settings-segment") ?? [])]
        .find((item) => item.textContent === label)
        ?.querySelector("input");
    expect(section()?.querySelector('[role="radiogroup"]')?.getAttribute("aria-labelledby")).toBe(
      "settings-theme",
    );
    expect(radio("Dark")?.checked).toBe(true);
    await act(async () => radio("Light")?.click());
    expect(radio("Light")?.checked).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("spi-code.appearance")).toBe("light");
    expect(shell.spi.setAppearance).toHaveBeenLastCalledWith("light");
    await act(async () => radio("System")?.click());
    expect(radio("System")?.checked).toBe(true);
    expect(localStorage.getItem("spi-code.appearance")).toBeNull();
    expect(shell.spi.setAppearance).toHaveBeenLastCalledWith(
      matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    );
    await close();
  } finally {
    await shell.cleanup();
  }
});

describe.each([
  { platform: "macOS", userAgent: "Mozilla/5.0 (Macintosh; Mac OS X)", mod: { metaKey: true } },
  { platform: "Windows", userAgent: "Mozilla/5.0 (Windows NT 10.0)", mod: { ctrlKey: true } },
])("the Settings shortcut on $platform", ({ userAgent, mod }) => {
  const comma = (
    target: EventTarget,
    init: KeyboardEventInit = {},
    keyCode?: number,
  ): Promise<KeyboardEvent> =>
    act(async () => {
      const event = new KeyboardEvent("keydown", {
        key: ",",
        bubbles: true,
        cancelable: true,
        ...mod,
        ...init,
      });
      if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
      target.dispatchEvent(event);
      return event;
    });

  beforeEach(() => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens from the page", async () => {
    const shell = await mountShell();
    try {
      const event = await comma(document.body);
      expect(event.defaultPrevented).toBe(true);
      expect(dialog()).not.toBeNull();
      await close();
    } finally {
      await shell.cleanup();
    }
  });

  it("does not fire from Find's query input, and Find stays open", async () => {
    const shell = await mountShell();
    try {
      await act(async () => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true, ...mod }),
        );
      });
      const query = document.querySelector<HTMLInputElement>('input[aria-label="Find"]');
      expect(query).not.toBeNull();
      query?.focus();
      const event = await comma(query as HTMLInputElement);
      expect(event.defaultPrevented).toBe(false);
      expect(document.querySelector("[data-settings-section]")).toBeNull();
      expect(document.querySelector('input[aria-label="Find"]')).not.toBeNull();
    } finally {
      await shell.cleanup();
    }
  });

  it.each([
    ["an input", () => document.createElement("input")],
    ["a textarea", () => document.createElement("textarea")],
    ["a select", () => document.createElement("select")],
    [
      "a contenteditable",
      () => {
        const editor = document.createElement("div");
        editor.setAttribute("contenteditable", "true");
        editor.append(document.createElement("span"));
        return editor;
      },
    ],
  ])("does not fire from %s", async (_name, make) => {
    const shell = await mountShell();
    const field = make();
    shell.container.append(field);
    try {
      const event = await comma(field.firstElementChild ?? field);
      expect(event.defaultPrevented).toBe(false);
      expect(dialog()).toBeNull();
    } finally {
      field.remove();
      await shell.cleanup();
    }
  });

  it.each([
    ["isComposing", { isComposing: true }, undefined],
    ["keyCode 229", {}, 229],
  ])("does not fire while composing (%s)", async (_name, init, keyCode) => {
    const shell = await mountShell();
    try {
      const event = await comma(document.body, init, keyCode);
      expect(event.defaultPrevented).toBe(false);
      expect(dialog()).toBeNull();
    } finally {
      await shell.cleanup();
    }
  });
});
