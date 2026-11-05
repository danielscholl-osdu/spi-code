// Copyright 2026, Daniel Scholl
// SPDX-License-Identifier: MIT

import { PROTOCOL_VERSION, type SetupState, WatchMessageSchema } from "@spi-code/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Shell } from "../../app/Shell.js";
import { watchStore } from "../../store/watch.js";
import Setup from "./index.js";

type Tool = SetupState["tools"][number];
const tools: Tool["tool"][] = ["copilot", "git", "gh", "glab"];
let container: HTMLDivElement;
let root: Root;
let previous: Window["spi"];
const send = vi.fn();

beforeEach(() => {
  previous = window.spi;
  window.spi = { proof: false, postMessage: send, onMessage: () => () => {} };
  send.mockClear();
  watchStore.setState({ setup: null, sweep: null, snapshot: null, signin: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  watchStore.setState({ setup: null, sweep: null, snapshot: null, signin: {} });
  window.spi = previous;
});
const render = (node: ReactNode = <Setup />) => act(async () => root.render(node));
const receive = (type: string, payload: unknown) =>
  act(async () => {
    watchStore
      .getState()
      .receive({ version: PROTOCOL_VERSION, kind: "event", id: "host", type, payload });
  });
const state = (overrides: Partial<Tool> = {}): SetupState => ({
  watchReady: false,
  disabledReason: "Sign in to gh with repo and workflow scopes",
  tools: tools.map((tool) => ({ tool, state: "ready", action: null, ...overrides })),
});

const cases: [Tool["state"], Tool["action"], string][] = [
  ["missing", "install", "Missing"],
  ["installing", "install", "Installing"],
  ["ready", null, "Ready"],
  ["needs-update", "install", "Needs update"],
  ["failed", "attention", "Failed"],
  ["signed-out", "signin", "Signed out"],
  ["scope-missing", "signin", "Scope missing"],
  ["no-seat", "attention", "No Copilot seat"],
  ["classic-token", "attention", "Classic ghp_ token"],
];
it.each(cases)(
  "shows one state and at most one action per tool: %s",
  async (status, action, label) => {
    await receive("setup.state", state({ state: status, action }));
    await render();
    for (const name of ["Copilot", "git", "gh", "glab"]) {
      const row = container.querySelector(`section[aria-label="${name}"]`);
      expect(row?.querySelector("p")?.textContent).toBe(label);
      const buttons = row?.querySelectorAll<HTMLButtonElement>("button");
      expect(buttons).toHaveLength(action ? 1 : 0);
      if (action) expect(buttons?.[0]?.disabled).toBe(status === "installing");
    }
  },
);

it("sends validated install and sign-in requests through the shared store port", async () => {
  const setup = state();
  setup.tools[1] = { tool: "git", state: "missing", action: "install" };
  setup.tools[2] = {
    tool: "gh",
    state: "scope-missing",
    action: "signin",
    missingScopes: ["workflow"],
  };
  await receive("setup.state", setup);
  await render();
  for (const button of container.querySelectorAll<HTMLButtonElement>("button")) {
    await act(async () => button.click());
  }
  expect(
    send.mock.calls.map(([message]) => {
      const parsed = WatchMessageSchema.parse(message);
      return { type: parsed.type, payload: parsed.payload };
    }),
  ).toEqual([
    { type: "setup.install", payload: { tool: "git" } },
    { type: "setup.signin", payload: { tool: "gh" } },
  ]);
  expect(container.textContent).toContain("Required scopes: workflow");
});

it("shows attention explanations without sending an install or sign-in", async () => {
  await receive("setup.state", state({ state: "classic-token", action: "attention" }));
  await render();
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
  expect(container.textContent).toContain("gh OAuth browser sign-in");
  expect(send).not.toHaveBeenCalled();
});

it("shows live device codes and URLs independently for each tool, then errors and completion", async () => {
  await receive("setup.state", state({ state: "signed-out", action: "signin" }));
  await render();
  await receive("setup.signin.progress", {
    tool: "gh",
    state: "device-code",
    deviceCode: "ABCD-1234",
    url: "https://github.com/login/device",
  });
  await receive("setup.signin.progress", { tool: "glab", state: "starting" });
  expect(container.querySelector("code")?.textContent).toBe("ABCD-1234");
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://github.com/login/device",
  );
  expect(
    container.querySelector<HTMLButtonElement>('section[aria-label="gh"] button')?.disabled,
  ).toBe(true);
  await receive("setup.signin.progress", { tool: "gh", state: "waiting" });
  expect(container.querySelector("code")?.textContent).toBe("ABCD-1234");
  await receive("setup.signin.progress", {
    tool: "gh",
    state: "failed",
    reason: "Device code expired",
  });
  expect(container.querySelector('section[aria-label="gh"] [role="alert"]')?.textContent).toBe(
    "Device code expired",
  );
  expect(container.querySelector("code")).toBeNull();
  await receive("setup.signin.progress", { tool: "glab", state: "completed" });
  expect(container.textContent).toContain("Sign-in completed");
});

it.each([0, 9, 10, 11])("flags points only below the reported floor: %s", async (remaining) => {
  await receive("sweep.status", { remaining, floor: 10, resetAt: null, deferredAreas: [] });
  await render();
  const budget = container.querySelector('section[aria-label="GraphQL budget"]');
  expect(budget?.textContent).toContain(`Points left: ${remaining}`);
  expect(budget?.querySelector('[role="alert"]') !== null).toBe(remaining < 10);
});

it("distinguishes an unknown budget and floor from zero", async () => {
  await render();
  expect(container.textContent).toContain("Points left: unknown");
  expect(container.textContent).toContain("Pacer floor not reported");
});

it("lands on Setup when the first host state is not ready and gates every Watch route with its reason", async () => {
  await render(<Shell />);
  await receive("setup.state", state());
  expect(container.querySelector("main h1")?.textContent).toBe("Setup");
  expect(container.querySelector('nav [aria-current="page"]')?.textContent).toBe("Setup");
  const buttons = container.querySelectorAll<HTMLButtonElement>("nav button");
  for (let index = 0; index < 6; index++) {
    await act(async () => buttons[index]?.click());
    expect(container.querySelector("main [role='status']")?.textContent).toContain(
      state().disabledReason,
    );
  }
  await receive("setup.state", state());
  expect(container.querySelector("main h1")?.textContent).toBe("Horizon");
  await receive("setup.state", { ...state(), watchReady: true, disabledReason: null });
  expect(container.textContent).not.toContain("Watch unavailable");
});

it("keeps Today as the first route when Watch is ready", async () => {
  await receive("setup.state", { ...state(), watchReady: true, disabledReason: null });
  await render(<Shell />);
  expect(container.querySelector("main h1")?.textContent).toBe("Today");
});
