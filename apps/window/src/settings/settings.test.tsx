// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  blocksWatch,
  PROTOCOL_VERSION,
  type SetupState,
  type SweepStatus,
  type ViewSnapshot,
  ViewSnapshotSchema,
} from "@spi-code/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import briefing from "../../../../fixtures/rib-59d6895/oracle/briefing.json?raw";
import releases from "../../../../fixtures/rib-59d6895/oracle/releases.json?raw";
import november6 from "../../../../fixtures/watch/snapshot-1106.json?raw";
import { navigate, relaunch } from "../app/routes.js";
import { Shell } from "../app/Shell.js";
import { midSweep, savedSweep, sweepStatus } from "../components/sweep/test-helper.js";
import { selectionStore } from "../panels/selection.js";
import { testSnapshot } from "../store/test-snapshot.js";
import { watchStore } from "../store/watch.js";
import { clockTime, timeUnit } from "../time.js";

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
  const rows = (["copilot", "git", "gh", "glab"] as const).map((tool, index) => ({
    tool,
    state: states[index] ?? "ready",
    action: null,
  }));
  const blocking = rows.find(blocksWatch);
  return {
    watchReady: blocking === undefined,
    disabledReason: blocking ? `${blocking.tool} is not ready` : null,
    tools: rows,
  };
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.location.hash = "";
  localStorage.removeItem("spi-code.last-place");
  relaunch();
  viewport(1280);
  watchStore.setState({
    setup: tools(["ready", "ready", "ready", "ready"]),
    setupCheckRequest: null,
    setupCheckError: null,
    signin: {},
    signinOutcome: {},
    signinRequest: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  watchStore.setState(previousStore);
  localStorage.removeItem("spi-code.appearance");
  localStorage.removeItem("spi-code.last-place");
  relaunch();
});

it("opens once on the first not-ready state over the gate, names only Watch blockers and reopens from the gate", async () => {
  watchStore.setState({ setup: null });
  window.location.hash = "#security";
  const shell = await mountShell();
  const banner = () => dialog()?.querySelector<HTMLElement>(".settings-readiness-banner");
  try {
    expect(dialog()).toBeNull();
    await act(async () =>
      watchStore.setState({ setup: tools(["signed-out", "ready", "signed-out", "missing"]) }),
    );
    expect(section()?.dataset.settingsSection).toBe("readiness");
    expect(banner()?.textContent).toBe("Watch needs gh.");
    expect(banner()?.dataset.readiness).toBe("attention");
    expect(shell.container.querySelector("main [role='status']")?.textContent).toContain(
      "Watch unavailable",
    );
    expect(shell.container.querySelector("main h1")?.textContent).toBe("Security");
    await act(async () =>
      watchStore.setState({ setup: tools(["no-seat", "missing", "needs-update", "missing"]) }),
    );
    expect(banner()?.textContent).toBe("Watch needs git.");
    await act(async () => navItem("Appearance")?.click());
    await close();
    expect(dialog()).toBeNull();
    expect(window.location.hash).toBe("#security");
    await act(async () =>
      watchStore.setState({ setup: tools(["signed-out", "ready", "signed-out", "missing"]) }),
    );
    expect(dialog()).toBeNull();
    const opener = [...shell.container.querySelectorAll<HTMLButtonElement>("main button")].find(
      (button) => button.textContent === "Open Settings",
    );
    expect(opener).toBeDefined();
    opener?.focus();
    await act(async () => opener?.click());
    expect(section()?.dataset.settingsSection).toBe("readiness");
    expect(banner()?.textContent).toBe("Watch needs gh.");
    await close();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(shell.container.querySelector("main [role='status']")?.textContent).toContain(
      "Watch unavailable",
    );
  } finally {
    await shell.cleanup();
  }
});

it.each([
  { git: "missing", gh: "signed-out", message: "Watch needs git and gh." },
  { git: "needs-update", gh: "signed-out", message: "Watch needs gh." },
  { git: "missing", gh: "needs-update", message: "Watch needs git." },
] as const)("names the Watch blockers with git $git and gh $gh", async ({ git, gh, message }) => {
  watchStore.setState({ setup: tools(["signed-out", git, gh, "missing"]) });
  const shell = await mountShell();
  try {
    expect(dialog()?.querySelector(".settings-readiness-banner")?.textContent).toBe(message);
    expect(shell.container.querySelector("main [role='status']")?.textContent).toContain(
      "Watch unavailable",
    );
    await close();
  } finally {
    await shell.cleanup();
  }
});

it("opens nothing and shows no needs banner when only Copilot and glab need attention", async () => {
  watchStore.setState({ setup: tools(["no-seat", "needs-update", "needs-update", "missing"]) });
  const shell = await mountShell();
  try {
    expect(dialog()).toBeNull();
    expect(shell.container.querySelector("main")?.textContent).not.toContain("Watch unavailable");
    await press(",");
    expect(section()?.dataset.settingsSection).toBe("readiness");
    expect(dialog()?.querySelector(".settings-readiness-banner")).toBeNull();
    expect(section()?.textContent).not.toContain("Watch needs");
    await close();
  } finally {
    await shell.cleanup();
  }
});

it.each(["Go to Today", "close", "Escape", "close from Appearance"])(
  "keeps Settings open when Watch becomes ready, then lands on Today with %s",
  async (action) => {
    watchStore.setState({ setup: tools(["ready", "ready", "signed-out", "missing"]) });
    window.location.hash = "#environment";
    const shell = await mountShell();
    try {
      expect(dialog()).not.toBeNull();
      const mounted = dialog();
      await act(async () =>
        watchStore.setState({ setup: tools(["signed-out", "ready", "ready", "missing"]) }),
      );
      expect(dialog()).toBe(mounted);
      const banner = dialog()?.querySelector<HTMLElement>(".settings-readiness-banner");
      expect(banner?.dataset.readiness).toBe("ready");
      expect(banner?.querySelector("[role='status']")?.textContent).toBe("Watch is ready");
      expect(banner?.querySelector("button")?.textContent).toBe("Go to Today");
      expect(shell.container.querySelector("main")?.textContent).not.toContain("Watch unavailable");
      expect(window.location.hash).toBe("#environment");
      if (action === "Go to Today") {
        await act(async () => banner?.querySelector<HTMLButtonElement>("button")?.click());
      } else if (action === "Escape") {
        await press("Escape", {});
      } else {
        if (action === "close from Appearance")
          await act(async () => navItem("Appearance")?.click());
        await close();
      }
      expect(dialog()).toBeNull();
      expect(window.location.hash).toBe("#today");
      expect(shell.container.querySelector("header [data-place]")?.textContent).toBe("Today");
      await act(async () => navigate({ kind: "security" }));
      await press(",");
      expect(dialog()?.querySelector(".settings-readiness-banner")).toBeNull();
      await close();
      expect(window.location.hash).toBe("#security");
      await act(async () =>
        watchStore.setState({ setup: tools(["ready", "ready", "failed", "ready"]) }),
      );
      expect(dialog()).toBeNull();
      expect(window.location.hash).toBe("#security");
    } finally {
      await shell.cleanup();
    }
  },
);

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
    expect(section()?.querySelector("h1")).toBeNull();
    expect(section()?.querySelector(".readiness-group")).not.toBeNull();
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

it("opens on Readiness from the footer row and from Find, even after Appearance was the last section", async () => {
  const shell = await mountShell();
  const footer = () =>
    shell.container.querySelector<HTMLButtonElement>(
      '[data-slot="sidebar-footer"] [data-sidebar-row="settings"]',
    );
  try {
    await press(",");
    await act(async () => navItem("Appearance")?.click());
    await close();
    await act(async () => footer()?.click());
    expect(section()?.dataset.settingsSection).toBe("readiness");
    expect(shell.container.querySelector("header [data-place]")?.textContent).toBe("Today");
    await act(async () => navItem("Appearance")?.click());
    await close();
    await press("k");
    const settings = [...document.querySelectorAll<HTMLElement>(".palette-row")].find(
      (row) => row.querySelector(".palette-label")?.textContent === "Settings",
    );
    expect(settings?.querySelector(".palette-kind")?.textContent).toBe("Readiness");
    await act(async () => settings?.click());
    expect(document.querySelector('[aria-label="Find or ask"]')).toBeNull();
    expect(section()?.dataset.settingsSection).toBe("readiness");
    await close();
  } finally {
    await shell.cleanup();
  }
});

it("lights the footer row with readiness, shows no sweep time there, and reaches no Setup place", async () => {
  const shell = await mountShell();
  const footer = () => shell.container.querySelector('[data-slot="sidebar-footer"]');
  const dot = () => footer()?.querySelector<HTMLElement>(".sidebar-readiness-dot");
  try {
    expect(dot()?.dataset.readiness).toBe("ready");
    await act(async () => watchStore.setState({ setup: tools(["ready", "ready", "signed-out"]) }));
    expect(dot()?.dataset.readiness).toBe("attention");
    await act(async () =>
      watchStore.setState({ setup: tools(["ready", "failed", "signed-out", "ready"]) }),
    );
    expect(dot()?.dataset.readiness).toBe("failure");
    expect(dialog()).toBeNull();
    expect(footer()?.querySelector("time")).toBeNull();
    expect(footer()?.textContent).not.toMatch(/swept/i);
    expect(shell.container.querySelector('[data-sidebar-row="setup"]')).toBeNull();
    await act(async () => {
      window.location.hash = "#setup";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(shell.container.querySelector("header [data-place]")?.textContent).toBe("Today");
    expect(dialog()).toBeNull();
    await press("k");
    const labels = [...document.querySelectorAll(".palette-row .palette-label")].map(
      (label) => label.textContent,
    );
    expect(labels).toContain("Settings");
    expect(labels).not.toContain("Setup");
    await press("k");
  } finally {
    await shell.cleanup();
  }
});

it("checks all from the header, stays disabled through the host check and updates the local Checked time", async () => {
  const now = new Date("2026-11-08T15:05:00.000Z").getTime();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const initial = "2026-11-08T15:04:00.000Z";
  watchStore.setState({ setup: { ...tools(["ready"]), checkedAt: initial } });
  const shell = await mountShell();
  const check = () => dialog()?.querySelector<HTMLButtonElement>(".readiness-check");
  try {
    await press(",");
    expect(dialog()?.querySelector("header time")?.getAttribute("datetime")).toBe(initial);
    expect(dialog()?.querySelector(".readiness-checked")?.textContent).toBe(
      `Checked ${clockTime(initial, { now })}`,
    );
    await act(async () => {
      check()?.click();
      check()?.click();
    });
    expect(shell.spi.postMessage).toHaveBeenCalledTimes(1);
    expect(shell.spi.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "setup.check", payload: {} }),
    );
    expect(check()?.disabled).toBe(true);
    const requestId = watchStore.getState().setupCheckRequest;
    const updated = "2026-11-08T15:05:00.000Z";
    await act(async () =>
      watchStore.getState().receive({
        version: PROTOCOL_VERSION,
        id: "host",
        kind: "event",
        type: "setup.state",
        payload: { ...tools(["ready"]), checkedAt: updated },
      }),
    );
    expect(check()?.disabled).toBe(true);
    await act(async () =>
      watchStore.getState().receive({
        version: PROTOCOL_VERSION,
        id: requestId,
        kind: "event",
        type: "setup.state",
        payload: { ...tools(["ready"]), checkedAt: updated },
      }),
    );
    expect(check()?.disabled).toBe(false);
    expect(dialog()?.querySelector("header time")?.getAttribute("datetime")).toBe(updated);
    expect(dialog()?.querySelector(".readiness-checked")?.textContent).toBe(
      `Checked ${clockTime(updated, { now })}`,
    );
    await act(async () => navItem("Appearance")?.click());
    expect(check()).toBeNull();
    expect(dialog()?.querySelector(".readiness-checked")).toBeNull();
    await close();
  } finally {
    await shell.cleanup();
    vi.useRealTimers();
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
      "Sweep",
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

describe("the Sweep section", () => {
  const NOW = Date.parse("2026-11-06T14:05:00.000Z");
  const at = (time: string) => `2026-11-06T${time}.000Z`;
  const clock = (iso: string) => clockTime(iso, { now: NOW, hint: false });
  const lastSweep = {
    sweep: "sweep-1",
    startedAt: at("14:00:50"),
    endedAt: at("14:02:02"),
    outcome: "committed" as const,
    requested: false,
  };
  const status = (overrides: Partial<SweepStatus> = {}) =>
    sweepStatus({
      floor: 100,
      resetAt: at("14:37:00"),
      nextSweepAt: at("14:08:00"),
      lastSweep,
      ...overrides,
    });
  /** The recorded 11-06 snapshot, its release reads taken at 13:32. */
  const snapshot = (): { cursor: number; body: ViewSnapshot } => {
    const body = ViewSnapshotSchema.parse(JSON.parse(november6));
    return {
      cursor: 1,
      body: {
        ...body,
        provenance: body.provenance.map((entry) =>
          entry.envelope?.source === "releases"
            ? {
                ...entry,
                envelope: {
                  source: "releases",
                  state: "fresh",
                  observedAt: at("13:32:00"),
                  completeness: { kind: "complete" },
                },
              }
            : entry,
        ),
      },
    };
  };
  const oneFailed = () =>
    midSweep({
      first: false,
      outcome: "committed",
      sources: savedSweep().sources.map((source) =>
        source.source === "upstream"
          ? {
              source: "upstream",
              state: "failed",
              startedAt: at("14:01:00"),
              endedAt: at("14:01:01"),
              code: "signin",
              reason: "glab is not signed in to community.opengroup.org.",
            }
          : source,
      ),
    });
  const previousSelection = selectionStore.getState();
  const body = () => dialog()?.querySelector<HTMLElement>("[data-settings-section=sweep]");
  const summary = () =>
    [...(body()?.querySelectorAll(".sweep-summary > *") ?? [])].map((item) => item.textContent);
  const budget = () =>
    [...(body()?.querySelectorAll(".sweep-budget p") ?? [])].map((item) => item.textContent);
  const openSweep = async () => {
    await press(",");
    await act(async () => navItem("Sweep")?.click());
  };
  const style = document.createElement("style");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
    // Vitest leaves CSS out, so the stylesheet goes in by hand to read the stacked form.
    style.textContent = readFileSync(resolve("apps/window/src/settings/settings.css"), "utf8");
    document.head.append(style);
    watchStore.setState({ snapshot: snapshot(), sweep: status(), progress: oneFailed() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    style.remove();
    selectionStore.setState(previousSelection);
  });

  it("sits between Readiness and Appearance with the schedule, reads, budget and notifications", async () => {
    const shell = await mountShell();
    try {
      await openSweep();
      expect(
        [...(dialog()?.querySelectorAll(".settings-nav button") ?? [])].map(
          (button) => button.textContent,
        ),
      ).toEqual(["Readiness", "Sweep", "Appearance"]);
      expect(navItem("Sweep")?.getAttribute("aria-current")).toBe("page");
      expect(dialog()?.querySelector(".settings-crumb")?.textContent).toBe("Settings / Sweep");
      expect(dialog()?.querySelector("header .sweep-now > button")?.textContent).toBe("Sweep now");
      expect(dialog()?.querySelector("header .readiness-check")).toBeNull();
      expect(
        [...(body()?.querySelectorAll(".readiness-group-title") ?? [])].map(
          (title) => title.textContent,
        ),
      ).toEqual(["Schedule", "What a sweep reads", "GitHub budget", "Notifications"]);
      expect(summary()).toEqual([
        "Last sweep",
        `${clock(at("14:02:02"))} · took ${timeUnit(1, "min")} ${timeUnit(12, "s")} · 1 source failed`,
        "Next sweep",
        clockTime(at("14:08:00"), { now: NOW }),
      ]);
      expect(summary()[3]).toContain(`(in ${timeUnit(3, "min")})`);
      expect(
        [...(body()?.querySelectorAll(".sweep-reads th") ?? [])].map((th) => th.textContent),
      ).toEqual(["Source", "How often", "Last read"]);
      expect(
        [...(body()?.querySelectorAll(".sweep-reads tbody tr") ?? [])].map((row) =>
          [...row.querySelectorAll("td")].map((cell) => cell.textContent),
        ),
      ).toEqual([
        [
          "Sign-in, Fleet membership, GitHub issues and PRs, Workflow runs, Run approvals, Stack lifecycle runs, Template, Run details",
          "every sweep",
          `last read ${clock("2026-11-06T14:02:01.332Z")}`,
        ],
        [
          "Upstream GitLab, Upstream radar",
          `every ${timeUnit(30, "min")}`,
          `last read ${clock("2026-11-06T13:31:37.502Z")}`,
        ],
        ["Security alerts", `every ${timeUnit(30, "min")}`, "last read not read yet"],
        ["Release lines", "every hour", `last read ${clock(at("13:32:00"))}`],
      ]);
      expect(budget()).toEqual([
        `4,865 points left · resets ${clockTime(at("14:37:00"), { now: NOW })}`,
        "Below 100 points, GitHub reads wait for the reset so sweeps never spend what your own gh use needs.",
      ]);
      expect(body()?.querySelector(".sweep-budget [role=alert]")).toBeNull();
      expect([...(body()?.querySelectorAll(".sweep-prose") ?? [])].at(-1)?.textContent).toBe(
        "SPI Code tells you when a sweep finds something new that needs you, or when it can no longer read the program. Routine sweeps are quiet. Your system's notification settings control sound and quiet hours.",
      );
    } finally {
      await shell.cleanup();
    }
  });

  it.each([
    ["has passed", { nextSweepAt: at("14:04:59") }, true],
    ["is now", { nextSweepAt: at("14:05:00") }, true],
    ["is not armed", { nextSweepAt: null }, true],
    ["comes before the first snapshot", {}, false],
  ] as const)("shows no Next line when the next sweep %s", async (_, overrides, snapshotted) => {
    watchStore.setState({
      sweep: status(overrides),
      ...(snapshotted ? {} : { snapshot: null }),
    });
    const shell = await mountShell();
    try {
      await openSweep();
      expect(summary()).toEqual([
        "Last sweep",
        `${clock(at("14:02:02"))} · took ${timeUnit(1, "min")} ${timeUnit(12, "s")} · 1 source failed`,
      ]);
      expect(body()?.textContent).not.toContain("Next sweep");
    } finally {
      await shell.cleanup();
    }
  });

  it("names a stopped or unfinished last sweep, an unknown or low budget and never an expired reset", async () => {
    watchStore.setState({
      sweep: status({ lastSweep: null, remaining: null, resetAt: at("14:00:00") }),
    });
    const shell = await mountShell();
    try {
      await openSweep();
      expect(summary().slice(0, 2)).toEqual(["Last sweep", "none since SPI Code opened"]);
      expect(budget()[0]).toBe("GitHub budget not reported yet.");
      expect(body()?.textContent).not.toContain("points left");
      await act(async () =>
        watchStore.setState({
          sweep: status({
            lastSweep: { ...lastSweep, outcome: "cancelled" },
            remaining: 42,
            resetAt: at("14:00:00"),
            deferredAreas: [{ area: "details", reason: "budget_floor" }],
          }),
        }),
      );
      expect(summary()[1]).toBe(
        `${clock(at("14:02:02"))} · took ${timeUnit(1, "min")} ${timeUnit(12, "s")} · stopped`,
      );
      expect(budget()).toEqual([
        "42 points left · below the floor",
        "Below 100 points, GitHub reads wait for the reset so sweeps never spend what your own gh use needs.",
        "Run details: budget floor",
      ]);
      expect(body()?.querySelector(".sweep-budget [role=alert]")?.textContent).toBe(
        "42 points left · below the floor",
      );
    } finally {
      await shell.cleanup();
    }
  });

  it.each([0, 9, 10, 11])("flags points only below the reported floor: %s", async (remaining) => {
    watchStore.setState({ sweep: status({ remaining, floor: 10, resetAt: null }) });
    const shell = await mountShell();
    try {
      await openSweep();
      expect(budget()[0]).toBe(
        `${remaining} points left${remaining < 10 ? " · below the floor" : ""}`,
      );
      expect(body()?.querySelector(".sweep-budget [role=alert]") !== null).toBe(remaining < 10);
    } finally {
      await shell.cleanup();
    }
  });

  it("tells an unreported floor from a zero floor and never flags against it", async () => {
    watchStore.setState({ sweep: status({ remaining: 0, floor: undefined, resetAt: null }) });
    const shell = await mountShell();
    try {
      await openSweep();
      expect(budget()).toEqual(["0 points left", "The budget floor is not reported by the host."]);
      expect(body()?.querySelector(".sweep-budget [role=alert]")).toBeNull();
      await act(async () => watchStore.setState({ sweep: status({ remaining: 0, floor: 0 }) }));
      expect(budget()[1]).toBe(
        "Below 0 points, GitHub reads wait for the reset so sweeps never spend what your own gh use needs.",
      );
    } finally {
      await shell.cleanup();
    }
  });

  it.each([
    ["Mozilla/5.0 (Macintosh; Mac OS X)", "this Mac"],
    ["Mozilla/5.0 (Windows NT 10.0)", "Windows"],
  ])("words the wake on %s", async (userAgent, wakes) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    const shell = await mountShell();
    try {
      await press(",", userAgent.includes("Mac") ? { metaKey: true } : { ctrlKey: true });
      await act(async () => navItem("Sweep")?.click());
      expect(body()?.querySelector(".sweep-prose")?.textContent).toBe(
        `A sweep starts every 5\u00a0minutes while SPI Code is open, and when ${wakes} wakes. The top row's "next sync" is the forks' upstream sync, not a sweep.`,
      );
    } finally {
      await shell.cleanup();
    }
  });

  it("folds into the Sweep picker at 740 px and moves how often and last read under each source", async () => {
    const display = (selector: string) => {
      const element = body()?.querySelector(selector);
      return element ? getComputedStyle(element).display : undefined;
    };
    const shell = await mountShell();
    try {
      await openSweep();
      expect(display(".sweep-reads thead")).not.toBe("none");
      expect(display(".sweep-reads .mobile-label")).toBe("none");
      await close();
      viewport(740);
      await press(",");
      const picker = dialog()?.querySelector<HTMLSelectElement>(
        'header select[aria-label="Settings section"]',
      );
      expect(picker?.value).toBe("sweep");
      expect(picker?.selectedOptions[0]?.textContent).toBe("Sweep");
      expect(dialog()?.dataset.layout).toBe("picker");
      expect(dialog()?.querySelector("header .sweep-now > button")?.textContent).toBe("Sweep now");
      expect(display(".sweep-reads thead")).toBe("none");
      expect(display(".sweep-reads tbody tr")).toBe("grid");
      expect(display(".sweep-reads .mobile-label")).toBe("inline");
      const first = body()?.querySelector<HTMLElement>(".sweep-reads tbody td");
      expect(first && getComputedStyle(first).gridColumn).toBe("1 / -1");
    } finally {
      await shell.cleanup();
    }
  });

  it("leaves Readiness without the budget row and with a link that opens Sweep", async () => {
    const shell = await mountShell();
    try {
      await press(",");
      expect(section()?.dataset.settingsSection).toBe("readiness");
      expect(section()?.querySelector(".readiness-row[aria-label='GitHub API budget']")).toBeNull();
      expect(section()?.textContent).not.toContain("points left");
      const link = section()?.querySelector<HTMLButtonElement>(".readiness-sweep-link");
      expect(link?.textContent).toBe("GitHub budget is in Sweep →");
      await act(async () => link?.click());
      expect(section()?.dataset.settingsSection).toBe("sweep");
      expect(navItem("Sweep")?.getAttribute("aria-current")).toBe("page");
      await act(async () =>
        watchStore.setState({ setup: tools(["ready", "ready", "signed-out", "ready"]) }),
      );
      const readiness = [
        ...(dialog()?.querySelectorAll<HTMLButtonElement>("header .sweep-now button") ?? []),
      ].find((button) => button.textContent === "Open Readiness.");
      await act(async () => readiness?.click());
      expect(section()?.dataset.settingsSection).toBe("readiness");
    } finally {
      await shell.cleanup();
    }
  });

  it("closes the dialog and opens the sweep's Evidence from View live sweep", async () => {
    watchStore.setState({ progress: midSweep({ first: false }) });
    const shell = await mountShell();
    try {
      await openSweep();
      const view = dialog()?.querySelector<HTMLButtonElement>("header .sweep-now-view");
      expect(view?.textContent).toBe("View live sweep →");
      await act(async () => view?.click());
      expect(dialog()).toBeNull();
      expect(selectionStore.getState()).toMatchObject({
        open: true,
        tab: "evidence",
        evidenceScope: "sweep",
      });
    } finally {
      await shell.cleanup();
    }
  });
});
